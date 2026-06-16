import { randomUUID } from 'node:crypto'
import { type DB } from './db.js'
import { getLog } from './logger.js'

/**
 * R7/D6 通知抽象层：事件 → 渲染模板 → 逐渠道分发 → notification_log 留痕。
 * Phase 2 仅 email adapter（Resend HTTP API——家庭宽带直发 SMTP 必进垃圾箱）；
 * 后续渠道实现 NotificationChannel 即插（LINE Notify 已于 2025-03 停服，不得引用）。
 * 分发永不抛错：无 key 降级 skipped、HTTP 失败记 failed，业务事务不被通知阻塞。
 */

export interface NotificationMessage {
  subject: string
  text: string
}

export interface NotificationResult {
  ok: boolean
  skipped?: boolean
  error?: string
}

export interface NotificationChannel {
  id: string
  send(to: string, msg: NotificationMessage): Promise<NotificationResult>
}

export type NotifyEvent =
  | 'email_verification'
  | 'password_reset'
  | 'order_file_pending'
  | 'order_file_rejected'
  | 'order_confirmed'
  | 'order_ready'

export function emailChannel(): NotificationChannel {
  return {
    id: 'email',
    async send(to, msg) {
      const key = process.env['SPOOL_RESEND_API_KEY']
      const from = process.env['SPOOL_MAIL_FROM'] ?? 'Folioria S.P.O.O.L. <spool@folioria.com>'
      if (!key) {
        // dev 链路：无 key 时正文进控制台（本地验证从这里取链接），落痕 skipped
        console.log(`[notify skipped] ${msg.subject} → ${to}\n${msg.text}`)
        return { ok: false, skipped: true }
      }
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject: msg.subject, text: msg.text }),
        })
        if (!res.ok) {
          getLog().warn({ status: res.status, to }, 'resend API non-ok')
          return { ok: false, error: `resend_http_${res.status}` }
        }
        return { ok: true }
      } catch (err) {
        getLog().error({ err, to }, 'resend API fetch failed')
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

const CHANNELS: NotificationChannel[] = [emailChannel()]

function logResult(db: DB, event: NotifyEvent, channel: string, recipient: string, r: NotificationResult): void {
  db.prepare(
    `INSERT INTO notification_log (id, event, channel, recipient, status, error, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    event,
    channel,
    recipient,
    r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed',
    r.error ?? null,
    new Date().toISOString(),
  )
}

/** 给定地址直发（注册场景：用户尚无订阅配置语境） */
export async function notifyAddress(db: DB, event: NotifyEvent, to: string, msg: NotificationMessage): Promise<void> {
  for (const ch of CHANNELS) {
    let result: NotificationResult
    try {
      result = await ch.send(to, msg)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      logResult(db, event, ch.id, to, result)
    } catch (err) {
      getLog().error({ err, event, channel: ch.id, to }, 'notification_log INSERT failed')
    }
  }
}

/** 按用户订阅分发：notify_channels 选渠道、notify_addresses 可覆盖收件地址（缺省 email） */
export async function notifyUser(db: DB, event: NotifyEvent, userId: string, msg: NotificationMessage): Promise<void> {
  const user = db
    .prepare('SELECT email, notify_channels, notify_addresses FROM users WHERE id = ? AND archived = 0')
    .get(userId) as { email: string; notify_channels: string; notify_addresses: string } | undefined
  if (!user) {
    getLog().debug({ userId, event }, 'notifyUser: user not found or archived')
    return
  }
  let subscribed: string[]
  let addresses: Record<string, string>
  try {
    subscribed = JSON.parse(user.notify_channels) as string[]
    addresses = JSON.parse(user.notify_addresses) as Record<string, string>
  } catch (err) {
    getLog().warn({ userId, err }, 'notify_channels/addresses JSON parse failed, falling back to email')
    subscribed = ['email']
    addresses = {}
  }
  for (const ch of CHANNELS) {
    if (!subscribed.includes(ch.id)) continue
    const to = addresses[ch.id] ?? user.email
    let result: NotificationResult
    try {
      result = await ch.send(to, msg)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      logResult(db, event, ch.id, to, result)
    } catch (err) {
      getLog().error({ err, event, channel: ch.id, to }, 'notification_log INSERT failed')
    }
  }
}

/** 管理侧事件（审稿待办）广播给全部活跃 admin */
export async function notifyAdmins(db: DB, event: NotifyEvent, msg: NotificationMessage): Promise<void> {
  const admins = db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND archived = 0")
    .all() as Array<{ id: string }>
  for (const a of admins) {
    await notifyUser(db, event, a.id, msg)
  }
}

// ---------- 模板 ----------

/** 验证链接落在 web 哈希路由（#/verify/:token）；origin 由部署环境注入 */
export const verificationLink = (token: string): string =>
  `${process.env['SPOOL_PUBLIC_ORIGIN'] ?? 'http://localhost:5173'}/#/verify/${token}`

export const resetLink = (token: string): string =>
  `${process.env['SPOOL_PUBLIC_ORIGIN'] ?? 'http://localhost:5173'}/#/reset/${token}`

export const templates = {
  emailVerification(token: string): NotificationMessage {
    return {
      subject: 'Folioria · 邮箱验证',
      text: `感谢注册 Folioria 印刷工坊。\n\n请在 48 小时内打开以下链接完成邮箱验证（验证后方可在线下单）：\n${verificationLink(token)}\n\n若非本人操作，忽略本邮件即可。`,
    }
  },
  passwordReset(token: string): NotificationMessage {
    return {
      subject: 'Folioria · 重置密码',
      text: `我们收到了重置该账号密码的请求。\n\n请在 2 小时内打开以下链接设置新密码：\n${resetLink(token)}\n\n若非本人操作，忽略本邮件即可，密码不会变更。`,
    }
  },
  orderFilePending(orderNumber: string): NotificationMessage {
    return {
      subject: `S.P.O.O.L. · 订单 ${orderNumber} 待审稿`,
      text: `订单 ${orderNumber} 的文件已传齐，等待审稿。\n请在管理台 /admin/orders 处理。`,
    }
  },
  orderFileRejected(orderNumber: string, fileNote: string | null): NotificationMessage {
    return {
      subject: `Folioria · 订单 ${orderNumber} 文件需重传`,
      text: `您的订单 ${orderNumber} 中有文件未通过审稿，需要修改后重新上传。${
        fileNote ? `\n审稿意见：${fileNote}` : ''
      }\n请打开订单查询链接逐行查看并重传。`,
    }
  },
  orderConfirmed(orderNumber: string, totalDisplay: string): NotificationMessage {
    return {
      subject: `Folioria · 订单 ${orderNumber} 已确认`,
      text: `您的订单 ${orderNumber} 已确认排产，应付金额 ${totalDisplay}。\n完成后将另行通知取件。`,
    }
  },
  orderReady(orderNumber: string): NotificationMessage {
    return {
      subject: `Folioria · 订单 ${orderNumber} 可取件`,
      text: `您的订单 ${orderNumber} 已完成，可以取件了。\n取件时间与寄送事宜请与工坊确认。`,
    }
  },
}
