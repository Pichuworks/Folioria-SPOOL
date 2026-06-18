export interface PrinterConfig {
  code: string
  name: string
  ip: string
  snmpCommunity?: string
}

export interface ProbeConfig {
  printers: PrinterConfig[]
  snmpCommunity?: string
  timeoutMs?: number
}

export interface SupplyEntry {
  description: string
  maxCapacity: number
  currentLevel: number
  percentRemaining: number | null
}

export interface ProbeResult {
  protocol: 'ipp' | 'snmp' | 'http'
  supported: boolean
  port: number
  responseTimeMs: number
  error?: string
  details: Record<string, unknown>
}

export interface PrinterReport {
  code: string
  name: string
  ip: string
  probes: ProbeResult[]
  recommended: 'ipp' | 'snmp' | 'http' | 'none'
  probedAt: string
}

export interface ProbeOutput {
  generatedAt: string
  reports: PrinterReport[]
}
