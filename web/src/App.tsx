import { useEffect, useState } from 'react'
import Calculator from './Calculator'
import Dashboard from './Dashboard'

const getView = (): 'dashboard' | 'calculator' =>
  window.location.hash === '#/dashboard' ? 'dashboard' : 'calculator'

export default function App() {
  const [view, setView] = useState(getView)

  useEffect(() => {
    const onHash = () => setView(getView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const tab = (active: boolean) =>
    active ? 'font-medium text-emerald-900' : 'text-stone-500 hover:text-stone-800'

  return (
    <main className="min-h-screen bg-stone-50">
      <nav className="flex gap-6 border-b border-stone-200 bg-white px-8 py-3 text-sm">
        <span className="font-semibold text-emerald-900">S.P.O.O.L.</span>
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
