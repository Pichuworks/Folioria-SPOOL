import { useState, useEffect, useRef } from 'react'

interface Props {
  familyName: string
  givenName: string
  intimate: boolean
  glitchEnabled: boolean
}

export default function Shimmer({ familyName, givenName, intimate, glitchEnabled }: Props) {
  const [active, setActive] = useState(false)
  const [display, setDisplay] = useState(familyName)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => { setDisplay(familyName) }, [familyName])

  useEffect(() => {
    if (!glitchEnabled || !intimate || !familyName) return

    const schedule = () => {
      timer.current = setTimeout(() => {
        if (Math.random() < 0.3) {
          setActive(true)
          setTimeout(() => setDisplay('星街'), 100)
          setTimeout(() => setDisplay(familyName), 1000)
          setTimeout(() => setActive(false), 1200)
        }
        schedule()
      }, 5000 + Math.random() * 3000)
    }
    schedule()
    return () => clearTimeout(timer.current)
  }, [glitchEnabled, intimate, familyName])

  if (!familyName) return <span>{givenName}</span>
  return (
    <span>
      <span className={active ? 'egg-shimmer' : ''}>
        {display}
      </span>
      {givenName}
    </span>
  )
}
