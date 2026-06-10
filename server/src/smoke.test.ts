import { expect, it } from 'vitest'
import { APP_NAME } from './index.js'

it('vitest wiring works (server)', () => {
  expect(APP_NAME).toBe('spool-server')
})
