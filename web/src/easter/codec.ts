const _H = '8b71e597eb08bb4a6afaf5693f5b33517ad11195b9544d9054eafe462d7977c0'

export async function checkTrigger(input: string): Promise<boolean> {
  const buf = new TextEncoder().encode(input)
  const raw = await crypto.subtle.digest('SHA-256', buf)
  const hex = Array.from(new Uint8Array(raw), b => b.toString(16).padStart(2, '0')).join('')
  return hex === _H
}

export function decode(encoded: string, key: string): string {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
  const k = new TextEncoder().encode(key)
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! ^ k[i % k.length]!
  return new TextDecoder().decode(out)
}
