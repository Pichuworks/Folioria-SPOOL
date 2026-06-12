import { useEffect, useState, type ComponentType } from 'react'
import AdminEquipment from './AdminEquipment'
import AdminInventory from './AdminInventory'
import AdminJobs from './AdminJobs'
import AdminPricing from './AdminPricing'
import AdminReports from './AdminReports'
import AdminSettings from './AdminSettings'
import AdminUsers from './AdminUsers'
import Calculator from './Calculator'
import Dashboard from './Dashboard'
import Home from './Home'
import { Shell } from './spec'

const ROUTES: Record<string, { nav: string; title: string; folio: string; view: ComponentType }> = {
  '#/calculator': { nav: '自助报价', title: '自助报价', folio: 'QUOTE SHEET', view: Calculator },
  '#/dashboard': { nav: 'Dashboard', title: 'Dashboard', folio: 'S.P.O.O.L. CONSOLE', view: Dashboard },
  '#/admin/jobs': { nav: '作业', title: '作业管理', folio: 'JOBS LEDGER', view: AdminJobs },
  '#/admin/inventory': { nav: '库存', title: '库存管理', folio: 'STOCK ROOM', view: AdminInventory },
  '#/admin/pricing': { nav: '价目', title: '价目管理', folio: 'PRICE BOOK', view: AdminPricing },
  '#/admin/equipment': { nav: '设备', title: '设备管理', folio: 'PRESS FLEET', view: AdminEquipment },
  '#/admin/users': { nav: '用户', title: '用户管理', folio: 'STAFF ROSTER', view: AdminUsers },
  '#/admin/settings': { nav: '设置', title: '系统设置', folio: 'HOUSE RULES', view: AdminSettings },
  '#/admin/reports': { nav: '报表', title: '月度报表', folio: 'LEDGER DIGEST', view: AdminReports },
}

const getHash = (): string => (window.location.hash in ROUTES ? window.location.hash : '#/')

export default function App() {
  const [hash, setHash] = useState(getHash)

  useEffect(() => {
    const onHash = () => setHash(getHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const route = ROUTES[hash]
  if (!route) return <Home />

  const tab = (active: boolean) =>
    active ? 'whitespace-nowrap font-medium text-wine-ink' : 'whitespace-nowrap text-dim hover:text-ink'
  const View = route.view

  return (
    <Shell
      center={route.folio}
      nav={
        <>
          <a href="#/" className="whitespace-nowrap text-dim hover:text-ink">首页</a>
          {Object.entries(ROUTES).map(([h, r]) => (
            <a key={h} href={h} className={tab(h === hash)}>
              {r.nav}
            </a>
          ))}
        </>
      }
    >
      <h1 className="sr-only">{route.title}</h1>
      <View />
    </Shell>
  )
}
