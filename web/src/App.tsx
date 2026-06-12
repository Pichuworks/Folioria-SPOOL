import { useEffect, useState } from 'react'
import AdminJobs from './AdminJobs'
import Calculator from './Calculator'
import Dashboard from './Dashboard'
import Home from './Home'
import { Shell } from './spec'

type View = 'home' | 'dashboard' | 'calculator' | 'admin-jobs'

const getView = (): View => {
  if (window.location.hash === '#/dashboard') return 'dashboard'
  if (window.location.hash === '#/calculator') return 'calculator'
  if (window.location.hash === '#/admin/jobs') return 'admin-jobs'
  return 'home'
}

const FOLIO: Record<Exclude<View, 'home'>, string> = {
  dashboard: 'S.P.O.O.L. CONSOLE',
  calculator: 'QUOTE SHEET',
  'admin-jobs': 'JOBS LEDGER',
}

export default function App() {
  const [view, setView] = useState(getView)

  useEffect(() => {
    const onHash = () => setView(getView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (view === 'home') return <Home />

  const tab = (active: boolean) =>
    active ? 'whitespace-nowrap font-medium text-wine-ink' : 'whitespace-nowrap text-dim hover:text-ink'

  return (
    <Shell
      center={FOLIO[view]}
      nav={
        <>
          <a href="#/" className="whitespace-nowrap text-dim hover:text-ink">首页</a>
          <a href="#/calculator" className={tab(view === 'calculator')}>自助报价</a>
          <a href="#/dashboard" className={tab(view === 'dashboard')}>Dashboard</a>
          <a href="#/admin/jobs" className={tab(view === 'admin-jobs')}>作业</a>
        </>
      }
    >
      <h1 className="sr-only">
        {view === 'dashboard' ? 'Dashboard' : view === 'admin-jobs' ? '作业管理' : '自助报价'}
      </h1>
      {view === 'dashboard' ? <Dashboard /> : view === 'admin-jobs' ? <AdminJobs /> : <Calculator />}
    </Shell>
  )
}
