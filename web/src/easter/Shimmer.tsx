import { useState, useEffect } from 'react'

interface Props {
  familyName: string
  givenName: string
  intimate: boolean
  glitchEnabled: boolean
}

export default function Shimmer({ familyName, givenName, intimate, glitchEnabled }: Props) {
  const [changed, setChanged] = useState(false)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (!glitchEnabled || !intimate) {
      setChanged(false)
      setFlash(false)
      return
    }

    const delay = 500 + Math.random() * 3000
    const timers: ReturnType<typeof setTimeout>[] = []

    timers.push(setTimeout(() => {
      setFlash(true)
      timers.push(setTimeout(() => setChanged(true), 400))
      timers.push(setTimeout(() => setFlash(false), 1000))
    }, delay))

    return () => timers.forEach(t => clearTimeout(t))
  }, [glitchEnabled, intimate])

  if (!familyName) return <span>{givenName}</span>
  const display = changed ? '星街' : familyName
  return (
    <span>
      <span className={flash ? 'egg-shimmer' : ''}>{display}</span>
      {givenName}
    </span>
  )
}
