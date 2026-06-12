import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { buildApp, type App } from './src/app.js'
import { type DB } from './src/db.js'
import { spoolInit } from './src/init.js'
import { importSeed } from './src/seed.js'
import { createTestUser, makeTestDb } from './src/test-helpers.js'

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

function multipartPayload(filename: string, content: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----spool-test-boundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

async function testStreamDrain() {
  let db: DB
  let app: App
  let uploadDir: string
  
  try {
    db = makeTestDb()
    spoolInit(db, {
      baseCurrency: 'JPY',
      adminEmail: 'admin@folioria.jp',
      adminName: 'K君',
      adminPassword: 'initial-secret-pw',
    })
    importSeed(db)
    createTestUser(db, { email: 'a@cust.example' })
    createTestUser(db, { email: 'b@cust.example' })
    uploadDir = mkdtempSync(path.join(tmpdir(), 'spool-test-'))
    app = buildApp(db, { uploadDir, uploadMaxBytes: 1024 })

    // Create order as user A
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@cust.example', password: 'test-password' },
    })
    const token = /spool_session=([^;]+)/.exec(String(loginRes.headers['set-cookie']))?.[1]
    
    const orderRes = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: `spool_session=${token}` },
      payload: { items: [{ mode_id: 1, paper_id: 1, size_key: 'A4', quantity: 100 }] },
    })
    const order = orderRes.json() as any
    
    // Try to upload as user B (will fail with 404 before stream drain)
    const { payload, headers } = multipartPayload('test.pdf', PDF)
    const loginRes2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'b@cust.example', password: 'test-password' },
    })
    const token2 = /spool_session=([^;]+)/.exec(String(loginRes2.headers['set-cookie']))?.[1]
    
    console.log('Sending upload request that will fail at loadOwnedItem() check...')
    const start = Date.now()
    const uploadRes = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.id}/items/${order.items[0]?.id}/file`,
      headers: { ...headers, cookie: `spool_session=${token2}` },
      payload,
    })
    const duration = Date.now() - start
    
    console.log(`Response received in ${duration}ms`)
    console.log(`Status code: ${uploadRes.statusCode}`)
    console.log(`Body: ${JSON.stringify(uploadRes.json())}`)
    
    if (duration > 5000) {
      console.error('ERROR: Request took too long - possible stream hang!')
      process.exit(1)
    } else {
      console.log('SUCCESS: Stream was properly cleaned up (no hang detected)')
    }
    
  } finally {
    await app.close()
    db.close()
    rmSync(uploadDir, { recursive: true, force: true })
  }
}

testStreamDrain().catch(console.error)
