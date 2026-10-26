/**
 * scripts/verify-immediate-reply.mjs — 验证 wechat_reply 是「立即发送」而不是「排队等 turn 结束」。
 *
 * 背景（真实体验问题）：
 *   早期实现里 wechat_reply 只把内容塞进 outbox，真正 sendText 发生在
 *   turn/end 之后。于是 agent 只要还在连着调工具，用户在微信上就一片空白，
 *   然后突然收到一大坨。用户的原话是「不能在微信收到简短回复」。
 *
 * 这个脚本在干净环境里验证：
 *   1. wechat_reply 调用后，消息**立刻**发到微信（turn 还没结束）；
 *   2. turn 结束时不会重复发送；
 *   3. 正文（长篇分析）依旧不会推到微信。
 *
 *   node scripts/verify-immediate-reply.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clawbot-immediate-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')
const originalFetch = globalThis.fetch

// ── 假服务器 ─────────────────────────────────────────────────────────────
/** sendmessage 记录，带「当时这一轮是否已结束」标记。 */
const sent = []
/** 当前 turn 是否已结束 —— 用来判断「是否立即发送」。 */
let turnEnded = false
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
      qrcode: 'qr-imm',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x?qrcode=qr-imm&bot_type=3',
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
      if (item.text_item?.text) {
        sent.push({ text: item.text_item.text, beforeTurnEnd: !turnEnded })
      }
    }
    return json({ ret: 0, message_id: '1' })
  }
  if (u.includes('notifystart') || u.includes('notifystop')) return json({ ret: 0 })
  return json({ ret: 0 })
}

// ── 假 ctx ───────────────────────────────────────────────────────────────
let agentFollowupDone = false

function makeCtx() {
  const handlers = new Map()
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const agents = new Map()

  const ctx = {
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
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
    _internals: { handlers, routes, tools, effects, agents },
  }
  return ctx
}

/**
 * 假 agent：followup 时模拟「模型先调 wechat_reply 发一句，
 * 然后在 turn 还开着的情况下继续干很久活」。
 */
function makeAgent(sessionId, ctx) {
  let turn = 0
  return {
    id: sessionId,
    session: { id: sessionId },
    followup(input) {
      queueMicrotask(async () => {
        turn += 1
        turnEnded = false

        ctx.emit('session/event', { id: sessionId }, {
          type: 'user/message',
          data: {
            id: input.id,
            role: 'user',
            content: input.content,
            source: input.source,
          },
        })

        // 1) 先立即回复一句短的。
        const tool = ctx._internals.tools.get('wechat_reply')
        await tool.execute(
          { messages: ['收到，我先看看'] },
          { agent: { session: { id: sessionId } } },
        )

        // 2) 关键：在 turn 还没结束前，模拟 agent 继续干活（长耗时）。
        //    如果实现是「排队等 turn 结束」，这 300ms 内微信收不到任何东西。
        await new Promise((r) => setTimeout(r, 300))

        // 3) 输出给电脑端看的长正文（不该进微信）。
        ctx.emit('session/event', { id: sessionId }, {
          type: 'assistant/message',
          data: {
            turn,
            message: {
              content: [{ type: 'text', text: '【电脑端】长篇分析，不该发到微信。'.repeat(3) }],
            },
          },
        })

        // 4) 这一轮结束。
        turnEnded = true
        ctx.emit('session/event', { id: sessionId }, {
          type: 'turn/end',
          data: { turn, reason: { kind: 'completed' } },
        })
        agentFollowupDone = true
      })
    },
  }
}

async function waitFor(pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

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
console.log('立即回复验证（wechat_reply 不该等 turn 结束）')
console.log(`  DSH_HOME=${tmpHome}`)
console.log('')

const ctx = makeCtx()
await apply(ctx, {})

qrScript.push({
  status: 'confirmed',
  bot_token: 'tok-imm',
  ilink_bot_id: 'bot-imm@im.bot',
  baseurl: 'https://ilinkai.weixin.qq.com',
  ilink_user_id: 'me@im.wechat',
})
let res = makeRes()
await ctx._internals.routes.get('/dsh-wechat-clawbot/login').handler(makeReq(), res)
res = makeRes()
await ctx._internals.routes.get('/dsh-wechat-clawbot/login/status').handler(makeReq(), res)
assert.equal(res.body.status, 'confirmed', '登录应成功')

updatesQueue.push({
  ret: 0,
  get_updates_buf: 'cursor-imm',
  msgs: [
    {
      message_type: 1,
      from_user_id: 'imm@im.wechat',
      context_token: 'ctx-imm',
      item_list: [{ type: 1, text_item: { text: '在吗' } }],
    },
  ],
})

// 等第一条消息到达微信，并且此时 turn 还没结束。
const gotFirst = await waitFor(() => sent.length > 0, 8000)
const first = sent[0]

// 等这一轮彻底跑完，看有没有重复发送。
const finished = await waitFor(() => agentFollowupDone, 8000)
await new Promise((r) => setTimeout(r, 600))

console.log('微信实际收到的消息:')
for (const s of sent) {
  console.log(`  · ${JSON.stringify(s.text)}  ${s.beforeTurnEnd ? '(turn 结束前收到 ✅)' : '(turn 结束后收到)'}`)
}
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

check('wechat_reply 的内容在 turn 结束前就发到了微信', () => {
  assert.ok(gotFirst, '没有收到任何消息')
  assert.equal(first.text, '收到，我先看看')
  assert.equal(
    first.beforeTurnEnd,
    true,
    '这条消息应该在本轮结束前就发出（否则就是「排队等 turn 结束」）',
  )
})

check('turn 结束后不会重复发送同一条', () => {
  assert.ok(finished, '这一轮应正常结束')
  const same = sent.filter((s) => s.text === '收到，我先看看')
  assert.equal(same.length, 1, `不该重复发送，实际发了 ${same.length} 次`)
})

check('正文（长篇分析）没有推到微信', () => {
  assert.ok(
    !sent.some((s) => s.text.includes('长篇分析')),
    `正文泄漏到微信：${JSON.stringify(sent.map((s) => s.text))}`,
  )
})

check('总共只收到一条消息（那条立即回复）', () => {
  assert.equal(sent.length, 1, `实际收到 ${sent.length} 条：${JSON.stringify(sent.map((s) => s.text))}`)
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
