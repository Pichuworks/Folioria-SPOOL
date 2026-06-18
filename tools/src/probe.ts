import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkPort } from './check-port.js'
import { probeHttp } from './probers/http.js'
import { probeIpp } from './probers/ipp.js'
import { probeSnmp } from './probers/snmp.js'
import { printReport } from './format.js'
import type { ProbeConfig, ProbeResult, PrinterReport, ProbeOutput } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG = resolve(__dirname, '..', 'printers.json')
const DEFAULT_OUT = resolve(__dirname, '..', 'probe-results.json')
const DEFAULT_TIMEOUT = 5000

const USAGE = `Usage: tsx src/probe.ts [options]

Options:
  --config <path>   Config file (default: tools/printers.json)
  --out <path>      JSON output file (default: tools/probe-results.json)
  --timeout <ms>    Per-probe timeout (default: 5000)
  --only <code>     Probe a single printer by code
  --help            Show this help
`

function pickRecommended(probes: ProbeResult[]): 'ipp' | 'snmp' | 'http' | 'none' {
  const ipp = probes.find((p) => p.protocol === 'ipp' && p.supported)
  if (ipp?.details.hasMarkerLevels) return 'ipp'
  const snmp = probes.find((p) => p.protocol === 'snmp' && p.supported)
  if (snmp && ((snmp.details.suppliesCount as number) ?? 0) > 0) return 'snmp'
  if (ipp) return 'ipp' // IPP responded but no markers — still better than HTTP
  const http = probes.find((p) => p.protocol === 'http' && p.supported)
  if (http) return 'http'
  return 'none'
}

async function probePrinter(
  code: string,
  name: string,
  ip: string,
  community: string,
  timeoutMs: number,
): Promise<PrinterReport> {
  console.log(`Probing ${name} (${code}) at ${ip} ...`)

  // pre-check TCP ports in parallel
  const [ippOpen, httpOpen, httpsOpen] = await Promise.all([
    checkPort(ip, 631, 3000),
    checkPort(ip, 80, 3000),
    checkPort(ip, 443, 3000),
  ])

  // run protocol probes in parallel (SNMP is UDP, always attempt)
  const probePromises: Promise<ProbeResult>[] = []

  if (ippOpen) {
    probePromises.push(probeIpp(ip, timeoutMs))
  } else {
    probePromises.push(
      Promise.resolve({
        protocol: 'ipp' as const,
        supported: false,
        port: 631,
        responseTimeMs: 0,
        error: 'port 631 closed',
        details: {},
      }),
    )
  }

  probePromises.push(probeSnmp(ip, community, timeoutMs))

  if (httpOpen || httpsOpen) {
    probePromises.push(probeHttp(ip, timeoutMs))
  } else {
    probePromises.push(
      Promise.resolve({
        protocol: 'http' as const,
        supported: false,
        port: 80,
        responseTimeMs: 0,
        error: 'port 80 and 443 closed',
        details: {},
      }),
    )
  }

  const probes = await Promise.all(probePromises)

  return {
    code,
    name,
    ip,
    probes,
    recommended: pickRecommended(probes),
    probedAt: new Date().toISOString(),
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: DEFAULT_CONFIG },
      out: { type: 'string', default: DEFAULT_OUT },
      timeout: { type: 'string', default: String(DEFAULT_TIMEOUT) },
      only: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })

  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const configPath = resolve(values.config!)
  let config: ProbeConfig
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8')) as ProbeConfig
  } catch (e) {
    console.error(`Failed to read config: ${configPath}`)
    console.error(`Copy printers.example.json to printers.json and fill in your printer IPs.`)
    process.exit(1)
  }

  if (!config.printers || config.printers.length === 0) {
    console.error('No printers configured.')
    process.exit(1)
  }

  let printers = config.printers
  if (values.only) {
    printers = printers.filter((p) => p.code === values.only)
    if (printers.length === 0) {
      console.error(`Printer code "${values.only}" not found in config.`)
      process.exit(1)
    }
  }

  const timeoutMs = Number(values.timeout) || DEFAULT_TIMEOUT
  const community = config.snmpCommunity ?? 'public'

  const reports: PrinterReport[] = []
  for (const p of printers) {
    const report = await probePrinter(p.code, p.name, p.ip, p.snmpCommunity ?? community, timeoutMs)
    reports.push(report)
  }

  const output: ProbeOutput = {
    generatedAt: new Date().toISOString(),
    reports,
  }

  printReport(output)

  const outPath = resolve(values.out!)
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')
  console.log(`JSON results written to: ${outPath}`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
