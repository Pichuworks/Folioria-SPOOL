import type { FastifyBaseLogger } from 'fastify'

let _logger: FastifyBaseLogger | undefined

const noop = () => {}
const _noop = {
  fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop,
  silent: noop, child: () => _noop, level: 'silent',
} as unknown as FastifyBaseLogger

export function initLogger(logger: FastifyBaseLogger): void {
  _logger = logger
}

export function getLog(): FastifyBaseLogger {
  return _logger ?? _noop
}
