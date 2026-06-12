import { type FastifyReply, type FastifyRequest } from 'fastify'

/** 下单域守卫：401 未登录 → 403 改密未完成（D11，admin 供给的初始密码不得长期使用） */
export function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  if (!req.user) {
    void reply.status(401).send({ error: 'unauthorized' })
    return
  }
  if (req.user.must_change_password !== 0) {
    void reply.status(403).send({ error: 'password_change_required' })
    return
  }
  done()
}

/** 管理域守卫：401 未登录 → 403 改密未完成（D11）→ 403 非 admin */
export function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  if (!req.user) {
    void reply.status(401).send({ error: 'unauthorized' })
    return
  }
  if (req.user.must_change_password !== 0) {
    void reply.status(403).send({ error: 'password_change_required' })
    return
  }
  if (req.user.role !== 'admin') {
    void reply.status(403).send({ error: 'forbidden' })
    return
  }
  done()
}
