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
    active ? 'font-medium text-wine-ink' : 'text-dim hover:text-ink'

  return (
    <main className="min-h-screen bg-paper">
      <nav className="flex gap-6 border-b border-line bg-card px-8 py-3 text-sm">
        <a href="#/" className="font-semibold text-wine-ink">
          Folioria
        </a>
        <a href="#/calculator" className={tab(view === 'calculator')}>
          自助报价
        </a>
        <a href="#/dashboard" className={tab(view === 'dashboard')}>
          Dashboard
        </a>
      </nav>
      {view === 'dashboard' ? <Dashboard /> : <Calculator />}
    </main>
  )
}
