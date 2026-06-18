/** 严格解析整数输入：空串/非整数返回 null，调用方据此报错，避免静默 Math.trunc 改值（review L-input）。 */
export function parseIntStrict(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}
