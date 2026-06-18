import snmp = require('net-snmp')
import type { ProbeResult, SupplyEntry } from '../types.js'

// OIDs — standard Printer MIB (RFC 3805)
const OID_SYS_DESCR = '1.3.6.1.2.1.1.1.0'
const OID_MARKER_SUPPLIES = '1.3.6.1.2.1.43.11.1.1'
const COL_DESCRIPTION = 6
const COL_MAX_CAPACITY = 8
const COL_CURRENT_LEVEL = 9

export async function probeSnmp(
  ip: string,
  community: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const start = performance.now()

  const session = snmp.createSession(ip, community, {
    timeout: timeoutMs,
    retries: 1,
    version: snmp.Version2c,
  })

  try {
    // 1. check sysDescr
    const sysDescr = await new Promise<string | null>((resolve) => {
      session.get([OID_SYS_DESCR], (error: Error | null, varbinds: snmp.VarBind[]) => {
        if (error) { resolve(null); return }
        const vb = varbinds[0]
        if (!vb || snmp.isVarbindError(vb)) { resolve(null); return }
        resolve(String(vb.value))
      })
    })

    if (sysDescr === null) {
      return {
        protocol: 'snmp',
        supported: false,
        port: 161,
        responseTimeMs: Math.round(performance.now() - start),
        error: 'timeout or no SNMP response',
        details: {},
      }
    }

    // 2. walk marker supplies subtree
    const varbinds = await new Promise<snmp.VarBind[]>((resolve) => {
      const results: snmp.VarBind[] = []
      session.subtree(
        OID_MARKER_SUPPLIES,
        (vbs: snmp.VarBind[]) => { results.push(...vbs) },
        (error: Error | null) => {
          if (error) resolve(results) // return what we got
          else resolve(results)
        },
      )
    })

    // 3. group by marker index
    const markers = new Map<number, Partial<{ description: string; max: number; current: number }>>()

    for (const vb of varbinds) {
      if (snmp.isVarbindError(vb)) continue
      // OID: 1.3.6.1.2.1.43.11.1.1.<col>.<prtIdx>.<markerIdx>
      const parts = vb.oid.split('.')
      const col = Number(parts[parts.length - 3])
      const markerIdx = Number(parts[parts.length - 1])
      if (isNaN(col) || isNaN(markerIdx)) continue

      let entry = markers.get(markerIdx)
      if (!entry) { entry = {}; markers.set(markerIdx, entry) }

      if (col === COL_DESCRIPTION) entry.description = String(vb.value)
      else if (col === COL_MAX_CAPACITY) entry.max = Number(vb.value)
      else if (col === COL_CURRENT_LEVEL) entry.current = Number(vb.value)
    }

    const supplies: SupplyEntry[] = []
    for (const [, entry] of markers) {
      if (entry.description == null) continue
      const max = entry.max ?? -1
      const current = entry.current ?? -1
      // RFC 3805: -3 means "some remaining", -2 means "unknown"
      let pct: number | null = null
      if (max > 0 && current >= 0) {
        pct = Math.round((current / max) * 100)
      }
      supplies.push({
        description: entry.description,
        maxCapacity: max,
        currentLevel: current,
        percentRemaining: pct,
      })
    }

    return {
      protocol: 'snmp',
      supported: true,
      port: 161,
      responseTimeMs: Math.round(performance.now() - start),
      details: {
        sysDescr,
        suppliesCount: supplies.length,
        supplies,
      },
    }
  } finally {
    session.close()
  }
}
