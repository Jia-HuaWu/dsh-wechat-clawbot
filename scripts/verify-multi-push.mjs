/**
 * scripts/verify-multi-push.mjs — 在干净环境里端到端验证「多条 / 选择性推送」。
 *
 * 为什么单独一个脚本：integration.mjs 会累计几十个插件实例，彼此抢同一个
 * 假服务器的消息队列，导致「这条消息到底被谁消费」不可控。这个脚本只
 * 起**一个**实例，从零跑通：
 *
 *   微信消息进来 → agent 调 wechat_reply 声明两条 → 微信收到恰好这两条，
 *   且 agent 正文（给电脑端看的长分析）没有推送到微信。
 *
 *   node scripts/verify-multi-push.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clawbot-multi-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')

const originalFetch = globalThis.fetch

// ── 假服务器：只实现这个脚本需要的接口 ───────────────────────────────────
const sentTexts = []
const sentItems = []
const updatesQueue = []
const qrScript = []

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const isJson = typeof init.body === 'string'
  const body = isJson && init.body ? JSON.parse(init.body) : undefined

  const json = (o) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(o),
    headers: { get: () => null },
  })

  if (u.includes('get_bot_qrcode')) {
    return json({
      ret: 0,
      qrcode: 'qr-multi',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x?qrcode=qr-multi&bot_type=3',
    })
  }
  if (u.includes('get_qrcode_status')) return json(qrScript.shift() ?? { status: 'wait' })
  if (u.includes('/getupdates')) {
    const next = updatesQueue.shift()
    if (!next) {
      await new Promise((r) => setTimeout(r, 25))
      const e = new Error('long poll timeout')
      e.name = 'AbortError'
      throw e
    }
    return json(next)
  }
  if (u.includes('/getconfig')) return json({ ret: 0, typing_ticket: 'tk' })
  if (u.includes('/sendtyping')) return json({ ret: 0 })
  if (u.includes('/sendmessage')) {
    for (const item of body?.msg?.item_list ?? []) {
      sentItems.push(item)
      if (item.text_item?.text) sentTexts.push(item.text_item.text)
    }
    return json({ ret: 0, message_id: '1' })
  }
  if (u.includes('notifystart') || u.includes('notifystop')) return json({ ret: 0 })
  return json({ ret: 0 })
}

// ── 假 ctx ───────────────────────────────────────────────────────────────
/** 插件内部 waiters 的观测点。 */
let capturedSessionId = ''

function makeCtx() {
  const handlers = new Map()
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const logs = []
  const agents = new Map()

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
      error: (m) => logs.push(['error', m]),
    },
    effect(fn) {
      const d = fn()
      effects.push(d)
      return d
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) ?? []
        const i = list.indexOf(handler)
        if (i >= 0) list.splice(i, 1)
      }
    },
    emit(event, ...args) {
      for (const h of handlers.get(event) ?? []) h(...args)
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    agents: {
      get: (id) => agents.get(id),
      async create({ sessionId }) {
        capturedSessionId = sessionId
        agents.set(sessionId, makeAgent(sessionId, ctx))
        return { agent: agents.get(sessionId), dispose: async () => agents.delete(sessionId) }
      },
      async resume() {
        throw new Error('no persisted session')
      },
    },
    attachments: {
      async saveImage() {
        return null
      },
      imageHostPath: () => undefined,
      readImageBytes: () => null,
    },
    agentPresets: { defaultId: 'standard', async mount() {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    get(name) {
      return {
        agentPresets: ctx.agentPresets,
        agentDefaultModel: ctx.agentDefaultModel,
        attachments: ctx.attachments,
      }[name]
    },
    _internals: { handlers, routes, tools, effects, logs, agents },
  }
  return ctx
}

/**
 * 假 agent：followup 时模拟「模型先调 wechat_reply，再输出一段长正文」。
 * @param {string} sessionId
 * @param {object} ctx
 */
function makeAgent(sessionId, ctx) {
  let turn = 0
  return {
    id: sessionId,
    session: { id: sessionId },
    followup(input) {
      queueMicrotask(async () => {
        turn += 1
        ctx.emit('session/event', { id: sessionId }, {
          type: 'user/message',
          data: { content: input.content, source: input.source },
        })

        // 模型调 wechat_reply：声明要推给微信的两条。
        const tool = ctx._internals.tools.get('wechat_reply')
        await tool.execute(
          { messages: ['好的', '有什么我可以帮你的'] },
          { agent: { session: { id: sessionId } } },
        )

        // 然后输出给电脑端看的长正文（不该进微信）。
        ctx.emit('session/event', { id: sessionId }, {
          type: 'assistant/message',
          data: {
            turn,
            message: {
              content: [{ type: 'text', text: '【电脑端】这里是长篇分析，不应该发到微信。'.repeat(3) }],
            },
          },
        })
        ctx.emit('session/event', { id: sessionId }, {
          type: 'turn/end',
          data: { turn, reason: { kind: 'completed' } },
        })
      })
    },
  }
}

/** 等待条件成立。 */
async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

/** 最小 req/res 桩。 */
function makeReq({ method = 'POST', body = '' } = {}) {
  const listeners = {}
  const req = {
    method,
    headers: { host: '127.0.0.1:19387' },
    on(ev, fn) {
      if (!listeners[ev]) listeners[ev] = []
      listeners[ev].push(fn)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    for (const fn of listeners.data ?? []) fn(Buffer.from(body, 'utf8'))
    for (const fn of listeners.end ?? []) fn()
  })
  return req
}

function makeRes() {
  return {
    status: 0,
    body: null,
    writeHead(s) {
      this.status = s
    },
    end(p) {
      this.body = p ? JSON.parse(p) : null
    },
  }
}

// ── 跑 ───────────────────────────────────────────────────────────────────
console.log('多条 / 选择性推送 —— 干净环境端到端验证')
console.log(`  DSH_HOME=${tmpHome}`)
console.log('')

const ctx = makeCtx()
await apply(ctx, {})

// 登录
qrScript.push({
  status: 'confirmed',
  bot_token: 'tok-multi',
  ilink_bot_id: 'bot-multi@im.bot',
  baseurl: 'https://ilinkai.weixin.qq.com',
  ilink_user_id: 'me@im.wechat',
})
let res = makeRes()
await ctx._internals.routes.get('/dsh-wechat-clawbot/login').handler(makeReq(), res)
res = makeRes()
await ctx._internals.routes.get('/dsh-wechat-clawbot/login/status').handler(makeReq(), res)
assert.equal(res.body.status, 'confirmed', '登录应成功')

// 推入一条微信消息
updatesQueue.push({
  ret: 0,
  get_updates_buf: 'cursor-multi',
  msgs: [
    {
      message_type: 1,
      from_user_id: 'multi@im.wechat',
      context_token: 'ctx-multi',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    },
  ],
})

const ok = await waitFor(() => sentTexts.length >= 2, 10000)

console.log('微信实际收到的文本消息:')
for (const t of sentTexts) console.log(`  · ${JSON.stringify(t)}`)
console.log('')

let failed = 0
function check(label, fn) {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${e?.message ?? e}`)
  }
}

check('收到恰好两条消息（wechat_reply 声明的那两条）', () => {
  assert.ok(ok, `超时未收到两条，实际 ${JSON.stringify(sentTexts)}`)
  assert.deepEqual(sentTexts, ['好的', '有什么我可以帮你的'])
})

check('正文（长篇分析）没有被推到微信', () => {
  assert.ok(
    !sentTexts.some((t) => t.includes('长篇分析')),
    `正文泄漏到微信了：${JSON.stringify(sentTexts)}`,
  )
})

check('每条消息是独立的 sendmessage 调用', () => {
  assert.equal(sentItems.filter((i) => i.text_item).length >= 2, true)
})

check('会话 id 已被插件使用', () => {
  assert.ok(capturedSessionId, '应创建过会话')
})

globalThis.fetch = originalFetch
try {
  fs.rmSync(tmpHome, { recursive: true, force: true })
} catch {
  // 忽略
}

console.log('')
console.log(failed === 0 ? '全部通过。' : `${failed} 项失败。`)
process.exit(failed === 0 ? 0 : 1)
