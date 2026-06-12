import { useEffect, useState } from 'react'
import Calculator from './Calculator'
import Dashboard from './Dashboard'
import Home from './Home'

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
    <main className="min-h-screen bg-paper text-ink">
      <div className="mx-auto max-w-5xl px-6">
        <nav className="flex flex-wrap items-baseline gap-x-7 gap-y-1 border-b-2 border-ink pb-3 pt-5 text-[13px]">
          <a href="#/" className="text-[19px] font-bold leading-none tracking-[.04em] text-ink">
            Folioria
          </a>
          <a href="#/calculator" className={tab(view === 'calculator')}>
            自助报价
          </a>
          <a href="#/dashboard" className={tab(view === 'dashboard')}>
            Dashboard
          </a>
          <span className="ml-auto hidden font-mono text-[10px] tracking-[.14em] text-dim sm:inline">
            {view === 'dashboard' ? 'S.P.O.O.L. CONSOLE' : 'QUOTE SPECIMEN'}
          </span>
        </nav>
      </div>
      {view === 'dashboard' ? <Dashboard /> : <Calculator />}
    </main>
  )
}
