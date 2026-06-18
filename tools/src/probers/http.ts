import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ProbeResult } from '../types.js'

function tryHttp(
  ip: string,
  port: number,
  secure: boolean,
  timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string | undefined>; body: string } | null> {
  return new Promise((resolve) => {
    const fn = secure ? httpsRequest : httpRequest
    const req = fn(
      { hostname: ip, port, path: '/', method: 'GET', timeout: timeoutMs, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          if (size < 8192) {
            chunks.push(chunk)
            size += chunk.length
          }
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              server: Array.isArray(res.headers['server'])
                ? res.headers['server'][0]
                : res.headers['server'],
              location: Array.isArray(res.headers['location'])
                ? res.headers['location'][0]
                : res.headers['location'],
            },
            body: Buffer.concat(chunks).toString('utf-8').slice(0, 8192),
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

function detectUiType(body: string, headers: Record<string, string | undefined>): string | null {
  const lower = body.toLowerCase()
  if (lower.includes('remote ui') || lower.includes('imagerunner') || lower.includes('meap'))
    return 'Canon Remote UI'
  if (lower.includes('epsonnet') || lower.includes('epson web'))
    return 'EpsonNet Config'
  if (lower.includes('epson'))
    return 'Epson Web UI'
  if (lower.includes('oki') || lower.includes('oki data'))
    return 'OKI Web UI'
  if (headers.server?.toLowerCase().includes('canon'))
    return 'Canon Web UI'
  if (headers.server?.toLowerCase().includes('epson'))
    return 'Epson Web UI'
  return null
}

function extractTitle(body: string): string | null {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(body)
  return m?.[1]?.trim() ?? null
}

export async function probeHttp(ip: string, timeoutMs: number): Promise<ProbeResult> {
  const start = performance.now()

  const httpRes = await tryHttp(ip, 80, false, timeoutMs)

  if (httpRes) {
    const elapsed = Math.round(performance.now() - start)
    const title = extractTitle(httpRes.body)
    const uiType = detectUiType(httpRes.body, httpRes.headers)
    return {
      protocol: 'http',
      supported: true,
      port: 80,
      responseTimeMs: elapsed,
      details: {
        httpPort: 80,
        statusCode: httpRes.status,
        server: httpRes.headers.server ?? null,
        title,
        uiType,
      },
    }
  }

  const httpsRes = await tryHttp(ip, 443, true, timeoutMs)

  if (httpsRes) {
    const elapsed = Math.round(performance.now() - start)
    const title = extractTitle(httpsRes.body)
    const uiType = detectUiType(httpsRes.body, httpsRes.headers)
    return {
      protocol: 'http',
      supported: true,
      port: 443,
      responseTimeMs: elapsed,
      details: {
        httpPort: 443,
        https: true,
        statusCode: httpsRes.status,
        server: httpsRes.headers.server ?? null,
        title,
        uiType,
      },
    }
  }

  return {
    protocol: 'http',
    supported: false,
    port: 80,
    responseTimeMs: Math.round(performance.now() - start),
    error: 'timeout or connection refused on port 80 and 443',
    details: {},
  }
}
