import { request as httpRequest } from 'node:http'
import type { ProbeResult } from '../types.js'

// IPP value tags
const TAG_OPERATION_ATTRS = 0x01
const TAG_PRINTER_ATTRS = 0x04
const TAG_END_OF_ATTRS = 0x03
const TAG_INTEGER = 0x21
const TAG_ENUM = 0x23
const TAG_KEYWORD = 0x44
const TAG_URI = 0x45
const TAG_CHARSET = 0x47
const TAG_NATURAL_LANGUAGE = 0x48

const REQUESTED_ATTRS = [
  'printer-make-and-model',
  'printer-state',
  'printer-state-reasons',
  'marker-names',
  'marker-levels',
  'marker-colors',
  'marker-types',
  'marker-high-levels',
  'marker-low-levels',
]

function encodeAttr(tag: number, name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf-8')
  const valBuf = Buffer.from(value, 'utf-8')
  const buf = Buffer.alloc(1 + 2 + nameBuf.length + 2 + valBuf.length)
  let o = 0
  buf.writeUInt8(tag, o); o += 1
  buf.writeUInt16BE(nameBuf.length, o); o += 2
  nameBuf.copy(buf, o); o += nameBuf.length
  buf.writeUInt16BE(valBuf.length, o); o += 2
  valBuf.copy(buf, o)
  return buf
}

function buildRequest(printerUri: string): Buffer {
  const parts: Buffer[] = []

  // version 1.1, operation Get-Printer-Attributes (0x000B), request-id 1
  parts.push(Buffer.from([0x01, 0x01, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x01]))

  // operation-attributes group
  parts.push(Buffer.from([TAG_OPERATION_ATTRS]))
  parts.push(encodeAttr(TAG_CHARSET, 'attributes-charset', 'utf-8'))
  parts.push(encodeAttr(TAG_NATURAL_LANGUAGE, 'attributes-natural-language', 'en'))
  parts.push(encodeAttr(TAG_URI, 'printer-uri', printerUri))

  // requested-attributes (first has the name, rest have empty name)
  for (let i = 0; i < REQUESTED_ATTRS.length; i++) {
    parts.push(encodeAttr(TAG_KEYWORD, i === 0 ? 'requested-attributes' : '', REQUESTED_ATTRS[i]!))
  }

  parts.push(Buffer.from([TAG_END_OF_ATTRS]))
  return Buffer.concat(parts)
}

interface ParsedAttr {
  tag: number
  values: Array<string | number>
}

function parseResponse(data: Buffer): { statusCode: number; attrs: Map<string, ParsedAttr> } {
  let o = 2 // skip version
  const statusCode = data.readUInt16BE(o); o += 2
  o += 4 // skip request-id

  const attrs = new Map<string, ParsedAttr>()
  let currentName = ''

  while (o < data.length) {
    const tag = data.readUInt8(o)!; o += 1

    // group delimiter or end
    if (tag <= 0x0f) {
      if (tag === TAG_END_OF_ATTRS) break
      continue
    }

    const nameLen = data.readUInt16BE(o); o += 2
    const name = nameLen > 0 ? data.subarray(o, o + nameLen).toString('utf-8') : ''
    o += nameLen

    const valLen = data.readUInt16BE(o); o += 2
    const raw = data.subarray(o, o + valLen)
    o += valLen

    let value: string | number
    if ((tag === TAG_INTEGER || tag === TAG_ENUM) && valLen === 4) {
      value = raw.readInt32BE(0)
    } else {
      value = raw.toString('utf-8')
    }

    if (nameLen > 0) {
      currentName = name
      attrs.set(name, { tag, values: [value] })
    } else if (currentName) {
      const attr = attrs.get(currentName)
      if (attr) attr.values.push(value)
    }
  }

  return { statusCode, attrs }
}

function sendIppRequest(
  ip: string,
  path: string,
  body: Buffer,
  timeoutMs: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: ip,
        port: 631,
        path,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/ipp',
          'content-length': body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      },
    )
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
    req.write(body)
    req.end()
  })
}

const IPP_PATHS = ['/ipp/print', '/ipp/printer', '/ipp', '/']

export async function probeIpp(ip: string, timeoutMs: number): Promise<ProbeResult> {
  const start = performance.now()

  for (const path of IPP_PATHS) {
    const uri = `ipp://${ip}:631${path}`
    const reqBuf = buildRequest(uri)
    const resBuf = await sendIppRequest(ip, path, reqBuf, timeoutMs)

    if (!resBuf || resBuf.length < 8) continue

    // verify it's an IPP response (version bytes should be 1.x or 2.x)
    const major = resBuf.readUInt8(0)
    if (major < 1 || major > 2) continue

    const { statusCode, attrs } = parseResponse(resBuf)
    const elapsed = Math.round(performance.now() - start)

    const markerNames = attrs.get('marker-names')?.values as string[] | undefined
    const markerLevels = attrs.get('marker-levels')?.values as number[] | undefined
    const markerColors = attrs.get('marker-colors')?.values as string[] | undefined
    const markerTypes = attrs.get('marker-types')?.values as string[] | undefined
    const makeAndModel = attrs.get('printer-make-and-model')?.values[0] as string | undefined
    const printerState = attrs.get('printer-state')?.values[0] as number | undefined

    const hasMarkers = markerLevels != null && markerLevels.length > 0

    return {
      protocol: 'ipp',
      supported: true,
      port: 631,
      responseTimeMs: elapsed,
      details: {
        path,
        statusCode: `0x${statusCode.toString(16).padStart(4, '0')}`,
        makeAndModel: makeAndModel ?? null,
        printerState: printerState ?? null,
        hasMarkerLevels: hasMarkers,
        markerNames: markerNames ?? null,
        markerLevels: markerLevels ?? null,
        markerColors: markerColors ?? null,
        markerTypes: markerTypes ?? null,
      },
    }
  }

  return {
    protocol: 'ipp',
    supported: false,
    port: 631,
    responseTimeMs: Math.round(performance.now() - start),
    error: 'no IPP response on any path',
    details: {},
  }
}
