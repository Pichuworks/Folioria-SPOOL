import { describe, it, expect } from 'vitest'
import { decode, checkTrigger } from './codec'

// review M7：codec 是纯函数，此前零测试。本地 encode（XOR+base64）作为 decode 的逆，验证往返正确。
function encode(text: string, key: string): string {
  const bytes = new TextEncoder().encode(text)
  const k = new TextEncoder().encode(key)
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! ^ k[i % k.length]!
  return btoa(String.fromCharCode(...out))
}

describe('codec', () => {
  it('decode 是 XOR+base64 编码的逆：往返还原（含多字节/emoji/空串）', () => {
    const key = 'spool-egg-key'
    for (const text of ['hello', 'hello 世界 🐱', '', 'a', 'multi\nline\ttab']) {
      expect(decode(encode(text, key), key)).toBe(text)
    }
  })

  it('checkTrigger 对错误输入返回 false', async () => {
    expect(await checkTrigger('not-the-secret-phrase')).toBe(false)
  })
})
