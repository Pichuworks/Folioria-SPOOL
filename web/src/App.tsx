import { useEffect, useState } from 'react'
import Calculator from './Calculator'
import Dashboard from './Dashboard'
import Home from './Home'
import { Shell } from './spec'

type View = 'home' | 'dashboard' | 'calculator'

const getView = (): View => {
  if (window.location.hash === '#/dashboard') return 'dashboard'
  if (window.location.hash === '#/calculator') return 'calculator'
  return 'home'
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
      center={view === 'dashboard' ? 'S.P.O.O.L. CONSOLE' : 'QUOTE SHEET'}
      nav={
        <>
          <a href="#/" className="whitespace-nowrap text-dim hover:text-ink">首页</a>
          <a href="#/calculator" className={tab(view === 'calculator')}>自助报价</a>
          <a href="#/dashboard" className={tab(view === 'dashboard')}>Dashboard</a>
        </>
      }
    >
      <h1 className="sr-only">{view === 'dashboard' ? 'Dashboard' : '自助报价'}</h1>
      {view === 'dashboard' ? <Dashboard /> : <Calculator />}
    </Shell>
  )
}
