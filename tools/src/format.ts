import type { PrinterReport, ProbeOutput, SupplyEntry } from './types.js'

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function statusStr(ok: boolean): string {
  return ok ? 'OK' : '--'
}

function formatSupplies(levels: number[] | null, names: string[] | null): string {
  if (!levels || levels.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < levels.length; i++) {
    const name = names?.[i] ?? `#${i + 1}`
    const short = name
      .replace(/^#[0-9A-Fa-f]{6}\s*/, '')
      .replace(/Cartridge/i, '')
      .trim()
      .slice(0, 8)
    const lvl = levels[i]!
    parts.push(`${short}=${lvl < 0 ? '?' : lvl + '%'}`)
  }
  return parts.join(' ')
}

function formatSnmpSupplies(supplies: SupplyEntry[]): string {
  if (supplies.length === 0) return ''
  return supplies
    .map((s) => {
      const name = s.description.slice(0, 12)
      const pct = s.percentRemaining
      return `${name}=${pct != null ? pct + '%' : '?'}`
    })
    .join(' ')
}

export function printReport(output: ProbeOutput): void {
  console.log(`\nS.P.O.O.L. Printer Probe — ${output.generatedAt}\n`)

  for (const r of output.reports) {
    console.log(`${r.name} (${r.code}) — ${r.ip}`)

    for (const p of r.probes) {
      const status = statusStr(p.supported)
      let info = ''

      if (p.protocol === 'ipp' && p.supported) {
        const d = p.details
        const model = d.makeAndModel ? `model="${d.makeAndModel}"` : ''
        const markers = formatSupplies(
          d.markerLevels as number[] | null,
          d.markerNames as string[] | null,
        )
        info = [model, markers].filter(Boolean).join('  ')
      } else if (p.protocol === 'snmp' && p.supported) {
        const d = p.details
        const descr = d.sysDescr ? `sysDescr="${String(d.sysDescr).slice(0, 40)}"` : ''
        const supplies = formatSnmpSupplies((d.supplies as SupplyEntry[]) ?? [])
        info = [descr, supplies].filter(Boolean).join('  ')
      } else if (p.protocol === 'http' && p.supported) {
        const d = p.details
        const parts: string[] = []
        if (d.uiType) parts.push(`ui="${d.uiType}"`)
        else if (d.title) parts.push(`title="${d.title}"`)
        if (d.https) parts.push('(HTTPS)')
        info = parts.join('  ')
      } else if (!p.supported && p.error) {
        info = p.error
      }

      const proto = pad(p.protocol.toUpperCase(), 5)
      const port = pad(String(p.port), 4)
      console.log(`  ${proto} ${port} ${pad(status, 3)} ${info}`)
    }

    if (r.recommended !== 'none') {
      console.log(`  >>> recommended: ${r.recommended.toUpperCase()}`)
    }
    console.log()
  }

  // summary table
  console.log('Summary:')
  console.log(`  ${pad('Printer', 12)} ${pad('IPP', 6)} ${pad('SNMP', 6)} ${pad('HTTP', 6)} Recommended`)
  console.log(`  ${'─'.repeat(50)}`)
  for (const r of output.reports) {
    const ipp = r.probes.find((p) => p.protocol === 'ipp')
    const snmp = r.probes.find((p) => p.protocol === 'snmp')
    const http = r.probes.find((p) => p.protocol === 'http')
    console.log(
      `  ${pad(r.code, 12)} ${pad(statusStr(ipp?.supported ?? false), 6)} ${pad(statusStr(snmp?.supported ?? false), 6)} ${pad(statusStr(http?.supported ?? false), 6)} ${r.recommended === 'none' ? '(manual)' : r.recommended.toUpperCase()}`,
    )
  }
  console.log()
}
