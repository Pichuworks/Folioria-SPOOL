import { forwardRef } from 'react'
import Shimmer from './Shimmer'
import type { StarEntry } from './types'

interface Props {
  star: StarEntry
  glitchEnabled: boolean
}

const StarMessage = forwardRef<HTMLDivElement, Props>(({ star, glitchEnabled }, ref) => (
  <div ref={ref} className="egg-msg py-14 text-center" style={{ opacity: 0 }}>
    <div className="mx-auto mb-3 h-[3px] w-[3px] rounded-full" style={{ backgroundColor: '#f5e6c8' }} />
    <div className="mb-2 font-mono text-[11px] tracking-[.15em]" style={{ color: '#8B6914' }}>
      {star.signal}
    </div>
    <div className="mb-3 text-[18px] tracking-[.08em]" style={{ color: '#e8dcc8', fontFamily: 'var(--font-serif)' }}>
      <Shimmer
        familyName={star.familyName}
        givenName={star.givenName}
        intimate={star.intimate}
        glitchEnabled={glitchEnabled}
      />
    </div>
    <div className="mx-auto max-w-md text-[14px] leading-relaxed" style={{ color: '#c8bfb0' }}>
      {star.message.split('\n').map((line, i) => (
        <div key={i}>{'「'}{line}{'」'}</div>
      ))}
    </div>
  </div>
))

StarMessage.displayName = 'StarMessage'
export default StarMessage
