import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import AdminEquipment from './AdminEquipment'
import AdminInventory from './AdminInventory'
import AdminJobs from './AdminJobs'
import AdminOrders from './AdminOrders'
import AdminPricing from './AdminPricing'
import AdminReports from './AdminReports'
import AdminSettings from './AdminSettings'
import AdminUsers from './AdminUsers'
import {
  AUTH_EVENT,
  fetchMe,
  fetchPublicConfig,
  getMeCache,
  getPublicConfigCache,
  type MeDto,
  type PublicConfigDto,
} from './api'
import Dashboard from './Dashboard'
import Home from './Home'
import MyOrders from './MyOrders'
import OrderView from './OrderView'
import PriceList from './PriceList'
import Quote from './Quote'
import ResetPassword from './ResetPassword'
import Setup from './Setup'
import { Shell } from './spec'
import VerifyEmail from './VerifyEmail'

/** 下单域路由：公开导航三态（guest / 下单用户 / admin）都可见 */
const STOREFRONT_ROUTES: Record<string, { nav: string; title: string; folio: string; view: ComponentType }> = {
  '#/quote': { nav: '自助报价', title: '自助报价 · 在线下单', folio: 'QUOTE & ORDER', view: Quote },
  '#/price-list': { nav: '价目表', title: '公开价目表', folio: 'PRICE LIST', view: PriceList },
  '#/my/orders': { nav: '我的订单', title: '我的订单', folio: 'MY ORDERS', view: MyOrders },
}

/** 管理域路由：仅 admin 登录态出现在导航（公开导航不罗列管理链接） */
const ADMIN_ROUTES: Record<string, { nav: string; title: string; folio: string; view: ComponentType }> = {
  '#/dashboard': { nav: 'Dashboard', title: 'Dashboard', folio: 'S.P.O.O.L. CONSOLE', view: Dashboard },
  '#/admin/orders': { nav: '订单', title: '订单看板', folio: 'ORDER BOARD', view: AdminOrders },
  '#/admin/jobs': { nav: '作业', title: '作业管理', folio: 'JOBS LEDGER', view: AdminJobs },
  '#/admin/inventory': { nav: '库存', title: '库存管理', folio: 'STOCK ROOM', view: AdminInventory },
  '#/admin/pricing': { nav: '价目', title: '价目管理', folio: 'PRICE BOOK', view: AdminPricing },
  '#/admin/equipment': { nav: '设备', title: '设备管理', folio: 'PRESS FLEET', view: AdminEquipment },
  '#/admin/users': { nav: '用户', title: '用户管理', folio: 'STAFF ROSTER', view: AdminUsers },
  '#/admin/settings': { nav: '设置', title: '系统设置', folio: 'HOUSE RULES', view: AdminSettings },
  '#/admin/reports': { nav: '报表', title: '月度报表', folio: 'LEDGER DIGEST', view: AdminReports },
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
  if (!resolved) return <Home me={me ?? null} />

  const tab = (active: boolean) =>
    active ? 'whitespace-nowrap font-medium text-wine-ink' : 'whitespace-nowrap text-dim hover:text-ink'

  // 导航三态：guest（公开导航）/ 下单用户（公开导航 + 我的订单高亮语义）/ admin（公开导航 + 管理组）
  const isAdmin = me?.role === 'admin'
  const nav = (
    <>
      <a href="#/" className="whitespace-nowrap text-dim hover:text-ink">首页</a>
      {Object.entries(STOREFRONT_ROUTES).map(([h, r]) => (
        <a key={h} href={h} className={tab(h === resolved.navKey)}>
          {h === '#/my/orders' && !me ? '登录 / 注册' : r.nav}
        </a>
      ))}
      {isAdmin && (
        <>
          <span aria-hidden="true" className="hidden h-4 w-px bg-line md:block" />
          {Object.entries(ADMIN_ROUTES).map(([h, r]) => (
            <a key={h} href={h} className={tab(h === resolved.navKey)}>
              {r.nav}
            </a>
          ))}
        </>
      )}
    </>
  )

  return (
    <Shell center={resolved.folio} nav={nav}>
      <h1 className="sr-only">{resolved.title}</h1>
      {resolved.node}
    </Shell>
  )
}
