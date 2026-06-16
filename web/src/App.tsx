import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import Account, { AccountMenu, DashboardPill } from './Account'
import {
  AUTH_EVENT,
  fetchMe,
  fetchPublicConfig,
  getMeCache,
  getPublicConfigCache,
  type MeDto,
  type PublicConfigDto,
} from './api'
import Home from './Home'
import Login from './Login'
import MyOrders from './MyOrders'
import OrderView from './OrderView'
import PriceList from './PriceList'
import CoverSize from './CoverSize'
import Quote from './Quote'
import ResetPassword from './ResetPassword'
import Setup from './Setup'
import { Shell, Skeleton } from './spec'
import VerifyEmail from './VerifyEmail'

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
const AdminUsers = lazy(() => import('./AdminUsers'))

/** 下单域路由：公开导航三态（guest / 下单用户 / admin）都可见 */
const STOREFRONT_ROUTES: Record<string, { nav: string; title: string; folio: string; view: ComponentType; auth?: boolean }> = {
  '#/quote': { nav: '自助报价', title: '自助报价 · 在线下单', folio: 'QUOTE & ORDER', view: Quote },
  '#/cover-size': { nav: '封面尺寸', title: '封面尺寸计算', folio: 'COVER SIZE', view: CoverSize },
  '#/price-list': { nav: '价目表', title: '价目表', folio: 'PRICE LIST', view: PriceList },
  '#/my/orders': { nav: '我的订单', title: '我的订单', folio: 'MY ORDERS', view: MyOrders, auth: true },
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

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash || '#/')
  const [me, setMe] = useState<MeDto | null | undefined>(getMeCache)
  const [config, setConfig] = useState<PublicConfigDto | undefined>(getPublicConfigCache)

  useEffect(() => {
    const onHash = () => setHash(window.location.hash || '#/')
    const onAuth = () => setMe(getMeCache())
    window.addEventListener('hashchange', onHash)
    window.addEventListener(AUTH_EVENT, onAuth)
    fetchMe().then(setMe).catch(() => setMe(null))
    fetchPublicConfig().then(setConfig).catch(() => {})
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener(AUTH_EVENT, onAuth)
    }
  }, [])

  // 首次运行（无 system_config）→ 强制初始化向导，盖过一切路由
  if (config && !config.initialized) {
    return (
      <Shell center="FIRST RUN" nav={<span className="font-mono text-[10.5px] tracking-[.14em] text-dim">SETUP</span>}>
        <Setup
          onDone={(m) => {
            setMe(m)
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
          return <a key={h} href={h} className={tab(h, activeKey)}>{r.nav}</a>
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
      <Suspense fallback={<Skeleton />}>
        {resolved.node}
      </Suspense>
    </Shell>
  )
}
