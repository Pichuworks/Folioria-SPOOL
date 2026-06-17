import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import Account, { AccountMenu, DashboardPill } from './Account'
import {
  AUTH_EVENT,
  fetchPublicConfig,
  fetchUnreadCount,
  getPublicConfigCache,
  type PublicConfigDto,
} from './api'
import { useAuth } from './AuthContext'
import Home from './Home'
import Login from './Login'
import Setup from './Setup'
import { Shell, Skeleton } from './spec'

const Announcements = lazy(() => import('./Announcements'))
const CoverSize = lazy(() => import('./CoverSize'))
const MyOrders = lazy(() => import('./MyOrders'))
const OrderView = lazy(() => import('./OrderView'))
const PriceList = lazy(() => import('./PriceList'))
const Quote = lazy(() => import('./Quote'))
const ResetPassword = lazy(() => import('./ResetPassword'))
const VerifyEmail = lazy(() => import('./VerifyEmail'))

const Dashboard = lazy(() => import('./Dashboard'))
const AdminAlerts = lazy(() => import('./AdminAlerts'))
const AdminAudit = lazy(() => import('./AdminAudit'))
const AdminBoard = lazy(() => import('./AdminBoard'))
const AdminEquipment = lazy(() => import('./AdminEquipment'))
const AdminInventory = lazy(() => import('./AdminInventory'))
const AdminJobs = lazy(() => import('./AdminJobs'))
const AdminOrders = lazy(() => import('./AdminOrders'))
const AdminPricing = lazy(() => import('./AdminPricing'))
const AdminReports = lazy(() => import('./AdminReports'))
const AdminSettings = lazy(() => import('./AdminSettings'))
const AdminAnnouncements = lazy(() => import('./AdminAnnouncements'))
const AdminMembership = lazy(() => import('./AdminMembership'))
const AdminUsers = lazy(() => import('./AdminUsers'))

/** 下单域路由：公开导航三态（guest / 下单用户 / admin）都可见 */
const STOREFRONT_ROUTES: Record<string, { nav: string; title: string; folio: string; view: ComponentType; auth?: boolean }> = {
  '#/quote': { nav: '自助报价', title: '自助报价 · 在线下单', folio: 'QUOTE & ORDER', view: Quote },
  '#/cover-size': { nav: '封面尺寸', title: '封面尺寸计算', folio: 'COVER SIZE', view: CoverSize },
  '#/price-list': { nav: '价目表', title: '价目表', folio: 'PRICE LIST', view: PriceList },
  '#/my/orders': { nav: '我的订单', title: '我的订单', folio: 'MY ORDERS', view: MyOrders, auth: true },
  '#/announcements': { nav: '公告', title: '公告', folio: 'NOTICES', view: Announcements, auth: true },
}

/** 管理域路由：仅 admin 登录态出现在导航（公开导航不罗列管理链接） */
const ADMIN_ROUTES: Record<string, { nav: string; title: string; folio: string; view: ComponentType }> = {
  '#/dashboard': { nav: 'Dashboard', title: 'Dashboard', folio: 'S.P.O.O.L. CONSOLE', view: Dashboard },
  '#/admin/orders': { nav: '订单', title: '订单看板', folio: 'ORDER BOARD', view: AdminOrders },
  '#/admin/jobs': { nav: '作业', title: '作业管理', folio: 'JOBS LEDGER', view: AdminJobs },
  '#/admin/board': { nav: '排程', title: '生产排程', folio: 'PRODUCTION SCHEDULE', view: AdminBoard },
  '#/admin/inventory': { nav: '库存', title: '库存管理', folio: 'STOCK ROOM', view: AdminInventory },
  '#/admin/pricing': { nav: '价目', title: '价目管理', folio: 'PRICE BOOK', view: AdminPricing },
  '#/admin/equipment': { nav: '设备', title: '设备管理', folio: 'PRESS FLEET', view: AdminEquipment },
  '#/admin/users': { nav: '用户', title: '用户管理', folio: 'STAFF ROSTER', view: AdminUsers },
  '#/admin/membership': { nav: '会员', title: '会员管理', folio: 'MEMBERSHIP', view: AdminMembership },
  '#/admin/announcements': { nav: '公告', title: '公告管理', folio: 'BULLETIN BOARD', view: AdminAnnouncements },
  '#/admin/alerts': { nav: '报警', title: '报警与通知', folio: 'ALERT INBOX', view: AdminAlerts },
  '#/admin/settings': { nav: '设置', title: '系统设置', folio: 'HOUSE RULES', view: AdminSettings },
  '#/admin/reports': { nav: '报表', title: '月度报表', folio: 'LEDGER DIGEST', view: AdminReports },
  '#/admin/audit': { nav: '审计', title: '操作审计', folio: 'AUDIT TRAIL', view: AdminAudit },
}

const ROUTES = { ...STOREFRONT_ROUTES, ...ADMIN_ROUTES }

/** 旧入口 #/calculator → #/quote（配置器并入下单页） */
function RedirectToQuote() {
  useEffect(() => {
    window.location.replace('#/quote')
  }, [])
  return null
}

interface Resolved {
  title: string
  folio: string
  node: ReactNode
  navKey: string | null
}

function resolve(hash: string): Resolved | null {
  const route = ROUTES[hash]
  if (route) {
    const View = route.view
    return { title: route.title, folio: route.folio, node: <View />, navKey: hash }
  }
  if (hash === '#/calculator') {
    return { title: '自助报价', folio: 'QUOTE & ORDER', node: <RedirectToQuote />, navKey: null }
  }
  const order = /^#\/order\/([A-Za-z0-9_-]+)$/.exec(hash)
  if (order?.[1]) {
    return { title: '订单查询', folio: 'ORDER LOOKUP', node: <OrderView token={order[1]} />, navKey: null }
  }
  const verify = /^#\/verify\/([A-Za-z0-9_-]+)$/.exec(hash)
  if (verify?.[1]) {
    return { title: '邮箱验证', folio: 'EMAIL VERIFICATION', node: <VerifyEmail token={verify[1]} />, navKey: null }
  }
  const reset = /^#\/reset\/([A-Za-z0-9_-]+)$/.exec(hash)
  if (reset?.[1]) {
    return { title: '重置密码', folio: 'PASSWORD RESET', node: <ResetPassword token={reset[1]} />, navKey: null }
  }
  if (hash === '#/account') {
    return { title: '账号设置', folio: 'ACCOUNT', node: <Account />, navKey: null }
  }
  if (hash === '#/login') {
    return { title: '登录', folio: 'SIGN IN', node: <Login />, navKey: null }
  }
  return null // → Home
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error('ErrorBoundary caught:', error, info) }
  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '1rem' }}>页面出错了</h2>
          <p style={{ color: '#666', marginBottom: '1rem' }}>{this.state.error.message}</p>
          <button onClick={() => { this.setState({ error: null }); window.location.hash = '#/' }}>返回首页</button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash || '#/')
  const me = useAuth()
  const [config, setConfig] = useState<PublicConfigDto | undefined>(getPublicConfigCache)
  const [unread, setUnread] = useState(0)
  const meRef = useRef(me)
  meRef.current = me

  useEffect(() => {
    let cancelled = false
    const onHash = () => {
      setHash(window.location.hash || '#/')
      if (meRef.current) void fetchUnreadCount().then((n) => { if (!cancelled) setUnread(n) })
    }
    const onAuth = () => {
      if (meRef.current) void fetchUnreadCount().then((n) => { if (!cancelled) setUnread(n) })
      else setUnread(0)
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener(AUTH_EVENT, onAuth)
    if (me) void fetchUnreadCount().then((n) => { if (!cancelled) setUnread(n) })
    fetchPublicConfig().then((c) => { if (!cancelled) setConfig(c) }).catch(() => {})
    return () => {
      cancelled = true
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener(AUTH_EVENT, onAuth)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 首次运行（无 system_config）→ 强制初始化向导，盖过一切路由
  if (config && !config.initialized) {
    return (
      <Shell center="FIRST RUN" nav={<span className="font-mono text-[10.5px] tracking-[.14em] text-dim">SETUP</span>}>
        <Setup
          onDone={(_m) => {
            setConfig({ ...config, initialized: true })
            window.location.hash = '#/dashboard'
          }}
        />
      </Shell>
    )
  }

  const resolved = resolve(hash)

  const tab = (h: string, activeKey: string | null) =>
    h === activeKey ? 'whitespace-nowrap font-medium text-wine-ink' : 'whitespace-nowrap text-dim hover:text-ink'

  const buildNav = (activeKey: string | null): ReactNode => {
    const isAdmin = me?.role === 'admin'
    return (
      <>
        <a href="#/" className={tab('#/', activeKey)}>首页</a>
        {Object.entries(STOREFRONT_ROUTES).map(([h, r]) => {
          if (r.auth && !me) return null
          if (h === '#/my/orders') return null
          return (
            <a key={h} href={h} className={tab(h, activeKey)}>
              {r.nav}
              {h === '#/announcements' && unread > 0 && (
                <span className="ml-1 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-wine px-1 text-[9px] font-medium leading-none text-cream">
                  {unread}
                </span>
              )}
            </a>
          )
        })}
        {isAdmin && (
          <>
            <span aria-hidden="true" className="hidden h-4 w-px bg-line md:block" />
            {Object.entries(ADMIN_ROUTES).map(([h, r]) => {
              if (h === '#/dashboard') return null
              return <a key={h} href={h} className={tab(h, activeKey)}>{r.nav}</a>
            })}
          </>
        )}
        <span aria-hidden="true" className="hidden h-4 w-px bg-line md:block" />
        {me && <DashboardPill admin={isAdmin ?? false} active={activeKey === '#/dashboard'} />}
        <AccountMenu me={me ?? null} />
      </>
    )
  }

  if (!resolved) {
    if (me) return <Home me={me} nav={buildNav('#/')} />
    return <Home me={null} />
  }

  return (
    <Shell center={resolved.folio} nav={buildNav(resolved.navKey)}>
      <h1 className="sr-only">{resolved.title}</h1>
      <ErrorBoundary>
        <Suspense fallback={<Skeleton />}>
          {resolved.node}
        </Suspense>
      </ErrorBoundary>
    </Shell>
  )
}
