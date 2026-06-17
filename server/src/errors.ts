export const isConstraint = (err: unknown, kind: string): boolean =>
  err instanceof Error && err.message.includes(kind)

export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'string' }, message: { type: 'string' } },
} as const
