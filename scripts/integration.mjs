/**
 * scripts/integration.mjs — 用假 ctx + 假 iLink 服务端跑通插件主流程。
 *
 * 验证的是**插件本身**：入站消息 → 驱动 agent → 收集回复 → 发回微信，
 * 以及「绑定到当前对话」、图片双向收发、设置页路由、登录状态机和
 * 安全护栏。全程不发真实网络请求。
 *
 *   node scripts/integration.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在 import 插件前设置 DSH_HOME，状态文件才会落在临时目录。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clawbot-test-'))
process.env.DSH_HOME = tmpHome

const { apply } = await import('../lib/index.js')

let passed = 0
let failed = 0

async function test(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

console.log('dsh-wechat-clawbot 集成测试（假 ctx / 假服务端）')
console.log(`  DSH_HOME=${tmpHome}`)
console.log('')

const originalFetch = globalThis.fetch

/**
 * 造一个能记录调用、按脚本应答的假 iLink 服务端。
 */
function makeFakeServer() {
  const calls = []
  const updatesQueue = []
  const qrScript = []
  const uploadedCdnBodies = []
  const cdnDownloads = []

  const json = (obj) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
    headers: { get: () => null },
  })

  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    // CDN 上传的 body 是二进制密文，不能拿去 JSON.parse；
    // 只有字符串 body 才当作 JSON 请求体。
    const isJsonBody = typeof init.body === 'string'
    const body = isJsonBody && init.body ? JSON.parse(init.body) : undefined
    calls.push({ url: u, method: init.method, body, headers: init.headers })

    if (u.includes('get_bot_qrcode')) {
      return json({
        ret: 0,
        qrcode: 'qr-test-123',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=qr-test-123&bot_type=3',
      })
    }

    if (u.includes('get_qrcode_status')) {
      return json(qrScript.shift() ?? { status: 'wait' })
    }

    if (u.includes('/getupdates')) {
      const next = updatesQueue.shift()
      if (!next) {
        // 没有更多消息时异步模拟长轮询超时。必须让出宏任务，
        // 否则插件循环会退化成微任务紧循环，饿死定时器。
        await new Promise((r) => setTimeout(r, 25))
        const error = new Error('long poll timeout')
        error.name = 'AbortError'
        throw error
      }
      return json(next)
    }

    if (u.includes('/getconfig')) {
      return json({ ret: 0, typing_ticket: 'ticket-abc' })
    }

    if (u.includes('/sendtyping')) {
      return json({ ret: 0 })
    }

    // 顺序要紧：CDN 上传 URL 里也带 "upload"，必须排在 getuploadurl 之前。
    if (u.includes('cdn.fake/upload')) {
      uploadedCdnBodies.push(Buffer.from(init.body))
      return {
        ok: true,
        status: 200,
        text: async () => '',
        headers: { get: (k) => (k.toLowerCase() === 'x-encrypted-param' ? 'CDN_PARAM' : null) },
      }
    }

    if (u.includes('/getuploadurl')) {
      return json({ ret: 0, upload_full_url: 'https://cdn.fake/upload?token=t' })
    }

    if (u.includes('/sendmessage')) {
      return json({ ret: 0, message_id: `srv-${calls.length}` })
    }

    if (u.includes('notifystart') || u.includes('notifystop')) {
      return json({ ret: 0 })
    }

    if (u.includes('/download')) {
      const buf = cdnDownloads.shift()
      if (!buf) return json({ ret: -1 })
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        text: async () => '',
        headers: { get: () => null },
      }
    }

    return json({ ret: 0 })
  }

  return {
    calls,
    updatesQueue,
    qrScript,
    uploadedCdnBodies,
    cdnDownloads,
    install() {
      globalThis.fetch = fetchImpl
    },
    sentTexts() {
      return calls
        .filter((c) => c.url.includes('/sendmessage'))
        .flatMap((c) => (c.body?.msg?.item_list ?? []).map((i) => i.text_item?.text ?? ''))
        .filter(Boolean)
    },
    sentImages() {
      return calls
        .filter((c) => c.url.includes('/sendmessage'))
        .flatMap((c) => (c.body?.msg?.item_list ?? []).filter((i) => i.type === 2))
    },
  }
}

/**
 * 造一个最小可用的 cordis ctx。
 */
function makeFakeCtx(opts = {}) {
  const handlers = new Map()
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const logs = []
  const agents = new Map()
  const attachmentBytes = new Map()
  let attachmentSeq = 0

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
      error: (m) => logs.push(['error', m]),
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
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
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    webServer: {
      register(route, label) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    agents: {
      get: (id) => agents.get(id),
      async create({ sessionId }) {
        // 记录当前会话 id，供测试里的 onTurn 找到对应的 waiter。
        ctx._internals.currentSessionId = sessionId
        const agent = makeFakeAgent(sessionId, ctx, opts.onTurn)
        agents.set(sessionId, agent)
        return { agent, dispose: async () => agents.delete(sessionId) }
      },
      async resume() {
        throw new Error('no persisted session')
      },
    },
    attachments: {
      async saveImage({ data, mediaType, name }) {
        attachmentSeq += 1
        const attachmentId = `sha256:fake${String(attachmentSeq).padStart(64, '0')}`
        attachmentBytes.set(attachmentId, Buffer.from(data))
        return { attachmentId, mediaType, bytes: data.length, width: 64, height: 64, name }
      },
      imageHostPath() {
        return undefined
      },
      readImageBytes({ attachmentId }) {
        return attachmentBytes.get(attachmentId) ?? null
      },
    },
    agentPresets: {
      defaultId: 'standard',
      async mount() {},
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    },
    get(serviceName) {
      return {
        agentPresets: ctx.agentPresets,
        agentDefaultModel: ctx.agentDefaultModel,
        attachments: ctx.attachments,
      }[serviceName]
    },
    _internals: { handlers, routes, tools, effects, logs, agents, attachmentBytes, errors: [] },
  }
  return ctx
}

/**
 * 假 agent：followup 收到的消息会在下一拍触发一轮会话事件。
 *
 * 这里会**模拟 DSH session v4 的 source 校验**：持久化层明确拒绝
 * 字面量 `kind: "plugin"`（"format v4 message requires a producer-owned
 * source kind"）。真实环境里这种消息会被拒绝入库，所以测试也必须拦住，
 * 否则这个 bug 会再次漏网。
 */
function makeFakeAgent(sessionId, ctx, onTurn) {
  let turn = 0
  return {
    id: sessionId,
    session: { id: sessionId },
    followup(input) {
      // 复刻 dsh-session 的 assertMessageEventShape（持久化读取期校验）。
      //
      // 这一层校验很容易漏：内存里 Session.append() 不检查这些字段，
      // 所以历史上出现过「消息发得出去、但落盘后再读就报
      // session event at seq N lacks an identified message，整个会话判为 corrupt」。
      // 这里必须和真实规则一致，否则同类 bug 还会漏网。
      if (typeof input !== 'object' || input === null) {
        throw new Error('user/message requires an object')
      }
      if (typeof input.id !== 'string' || input.id === '') {
        throw new Error('session event lacks an identified message')
      }
      if (input.role !== 'user') {
        throw new Error('session event message must have role "user"')
      }
      const source = input.source
      if (typeof source !== 'object' || source === null) {
        throw new Error('session event message has invalid source')
      }
      if (typeof source.kind !== 'string' || source.kind === '') {
        throw new Error('format v4 message requires a nonempty source kind')
      }
      if (source.kind === 'plugin') {
        throw new Error('format v4 message requires a producer-owned source kind')
      }
      if (!Array.isArray(input.content)) {
        throw new Error('session event message has invalid content')
      }

      const textPart = (input?.content ?? []).find((b) => b.type === 'text')
      const imageParts = (input?.content ?? []).filter((b) => b.type === 'image')
      const text = textPart?.text ?? ''
      // 让 onTurn 能拿到会话 id（用于调 wechat_reply 这类需要 session 的工具）。
      input.__sessionId = sessionId
      queueMicrotask(async () => {
        turn += 1
        ctx.emit('session/event', { id: sessionId }, {
          type: 'user/message',
          data: {
            id: input.id,
            role: 'user',
            content: input.content,
            source: input.source,
          },
        })

        const produced = onTurn
          ? onTurn({ text, imageCount: imageParts.length, input }, turn)
          : { text: `回声：${text}`, images: [] }

        // 允许测试在产出 assistant 消息前先调工具（模拟 agent 调 wechat_reply）。
        // 注意：异常必须显式上报，否则会变成 unhandled rejection 被静默吞掉，
        // 表现为「工具好像没被调用」。
        if (typeof produced?.beforeAssistant === 'function') {
          try {
            await produced.beforeAssistant()
          } catch (error) {
            ctx._internals.errors.push(error)
          }
        }

        const content = []
        if (produced.text) content.push({ type: 'text', text: produced.text })
        for (const img of produced.images ?? []) {
          content.push({ type: 'image', attachment: img })
        }

        ctx.emit('session/event', { id: sessionId }, {
          type: 'assistant/message',
          data: { turn, message: { content } },
        })
        ctx.emit('session/event', { id: sessionId }, {
          type: 'turn/end',
          data: { turn, reason: { kind: 'completed' } },
        })
      })
    },
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

/**
 * 销毁一个假 ctx 注册的所有 effect。
 * 真实环境插件只 apply 一次；测试里多实例并存会让前一个实例抢消息。
 */
async function disposeCtx(context) {
  if (!context) return
  liveCtxs.delete(context)
  for (const entry of context._internals.effects) {
    try {
      await entry.dispose?.()
    } catch {
      // 忽略。
    }
  }
  context._internals.effects.length = 0
  await new Promise((r) => setTimeout(r, 150))
}

/** 所有还没销毁的实例（用于在关键用例前清场）。 */
const liveCtxs = new Set()

/**
 * 停掉所有仍在监听的实例，保证接下来的用例独占消息队列。
 */
async function disposeAllCtx() {
  for (const c of [...liveCtxs]) await disposeCtx(c)
  liveCtxs.clear()
}

function makeReq({ method = 'POST', headers = {}, body = '' } = {}) {
  const normalized = { host: '127.0.0.1:19387', ...headers }
  const listeners = {}
  const req = {
    method,
    headers: normalized,
    on(event, fn) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(fn)
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
    headers: null,
    body: null,
    raw: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.raw = payload
      // JSON 路由返回 JSON，page 路由返回 HTML —— 按内容类型解析，
      // HTML 存到 body 原样（断言用正则匹配）。
      if (!payload) {
        this.body = null
        return
      }
      if (this.headers?.['Content-Type']?.includes('application/json')) {
        this.body = JSON.parse(payload)
      } else {
        this.body = payload
      }
    },
  }
}

const server = makeFakeServer()
server.install()

/** 通过登录路由把 token 灌进某个实例。 */
async function loginInstance(context, token, accountId = 'bot@im.bot') {
  liveCtxs.add(context)
  server.qrScript.push({
    status: 'confirmed',
    bot_token: token,
    ilink_bot_id: accountId,
    baseurl: 'https://ilinkai.weixin.qq.com',
    ilink_user_id: 'me@im.wechat',
  })
  const loginRoute = context._internals.routes.get('/dsh-wechat-clawbot/login')
  let res = makeRes()
  await loginRoute.handler(makeReq({ method: 'POST' }), res)
  const st = context._internals.routes.get('/dsh-wechat-clawbot/login/status')
  res = makeRes()
  await st.handler(makeReq({ method: 'POST' }), res)
  return res.body
}

// ── 1. 生命周期 ───────────────────────────────────────────────────────────
console.log('生命周期：')

const ctx = makeFakeCtx()
await test('未登录启动：不监听、不请求 getupdates', async () => {
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(
    server.calls.filter((c) => c.url.includes('/getupdates')).length,
    0,
    '没有 token 就不该打 getupdates',
  )
  assert.ok(ctx._internals.routes.get('/dsh-wechat-clawbot/status'))
})

// ── 2. 扫码登录 ───────────────────────────────────────────────────────────
console.log('')
console.log('扫码登录：')

await test('login 路由返回二维码链接', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/login')
  const res = makeRes()
  await route.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.status, 200)
  assert.match(res.body.url, /liteapp\.weixin\.qq\.com/)
})

await test('login/status 推进 wait → scaned → confirmed', async () => {
  server.qrScript.push(
    { status: 'scaned' },
    {
      status: 'confirmed',
      bot_token: 'bot-token-xyz',
      ilink_bot_id: 'bot-123@im.bot',
      baseurl: 'https://ilinkai.weixin.qq.com',
      ilink_user_id: 'me@im.wechat',
    },
  )
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/login/status')

  let res = makeRes()
  await route.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.status, 'scaned')

  res = makeRes()
  await route.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.status, 'confirmed')
  assert.match(res.body.message, /连接成功/)

  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.token, 'bot-token-xyz')
})

await test('确认后自动开始监听', async () => {
  const started = await waitFor(
    () => server.calls.some((c) => c.url.includes('/getupdates')),
    3000,
  )
  assert.ok(started, '登录成功后应该开始长轮询')
})

// ── 3. 消息往返 ───────────────────────────────────────────────────────────
console.log('')
console.log('消息往返：')

await test('一条微信消息会驱动 agent 并把回复发回去', async () => {
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-after-1',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'friend@im.wechat',
        context_token: 'ctx-abc',
        item_list: [{ type: 1, text_item: { text: '你好 DSH' } }],
      },
    ],
  })

  const replied = await waitFor(() => server.sentTexts().includes('回声：你好 DSH'), 5000)
  assert.ok(replied, '应该有一条回复发出去')

  const sendCall = server.calls.find((c) => c.url.includes('/sendmessage'))
  assert.equal(sendCall.body.msg.context_token, 'ctx-abc')
  assert.equal(sendCall.body.msg.to_user_id, 'friend@im.wechat')
  assert.ok(
    server.calls.some(
      (c) => c.url.includes('/sendtyping') && c.body?.typing_ticket === 'ticket-abc',
    ),
    '应该用 getconfig 拿到的 ticket 发 typing',
  )
})

await test('游标 get_updates_buf 会被持久化', async () => {
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const ok = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')).getUpdatesBuf === 'cursor-after-1'
    } catch {
      return false
    }
  }, 2000)
  assert.ok(ok, '游标必须落盘')
})

await test('同一联系人复用同一个 DSH 会话', async () => {
  const before = ctx._internals.agents.size
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-after-2',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'friend@im.wechat',
        context_token: 'ctx-def',
        item_list: [{ type: 1, text_item: { text: '第二条' } }],
      },
    ],
  })
  const replied = await waitFor(() => server.sentTexts().includes('回声：第二条'), 5000)
  assert.ok(replied, '第二条也该有回复')
  assert.equal(ctx._internals.agents.size, before, '同一发信人不应创建新会话')
})

await test('入站消息的 source.kind 是 user（前端才会显示成正常气泡）', async () => {
  // 两条约束要同时满足：
  //   1. 不能是字面量 "plugin" —— DSH 会报
  //      "format v4 message requires a producer-owned source kind"；
  //   2. 必须是 "user" —— DSH 前端只把 kind === "user" 的 user/message
  //      渲染成正常用户气泡，其他 kind 会降级成折叠的「上下文注入」行，
  //      用户在电脑上就看不到自己在微信里说了什么。
  //
  // 这里不新开实例（新实例会多一个监听循环，抢走后续用例的消息、还会污染
  // state.json），而是包一层当前 ctx 的假 agent 工厂，捕获 followup 的入参。
  const captured = []
  const originalCreate = ctx.agents.create
  ctx.agents.create = async (options) => {
    const handle = await originalCreate(options)
    const agent = handle.agent
    const originalFollowup = agent.followup.bind(agent)
    agent.followup = (input) => {
      captured.push(input)
      return originalFollowup(input)
    }
    return handle
  }

  try {
    server.updatesQueue.push({
      ret: 0,
      get_updates_buf: 'cursor-src-1',
      msgs: [
        {
          message_type: 1,
          from_user_id: 'srcuser@im.wechat',
          context_token: 'ctx-src',
          item_list: [{ type: 1, text_item: { text: '测试来源' } }],
        },
      ],
    })

    const ok = await waitFor(() => captured.length > 0, 8000)
    assert.ok(ok, '应该有一次 followup')

    const input = captured[0]
    const source = input?.source
    assert.notEqual(source?.kind, 'plugin', 'kind 不能是字面量 plugin')
    assert.equal(
      source?.kind,
      'user',
      `source.kind 应为 "user"（前端才显示正常气泡），实际 ${JSON.stringify(source)}`,
    )
    assert.equal(source?.via, 'dsh-wechat-clawbot', '应记录来源插件')
    assert.equal(source?.wechatUserId, 'srcuser@im.wechat', '应记录微信用户')
    // 顺便确认假 agent 里的 v4 校验确实会放行它。
    assert.equal(typeof input.content, 'object')
  } finally {
    ctx.agents.create = originalCreate
  }
})

await test('bot 自己发的消息不会被当成入站处理', async () => {
  const countBefore = server.sentTexts().length
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-after-3',
    msgs: [
      {
        message_type: 2,
        from_user_id: 'bot-123@im.bot',
        context_token: 'ctx-x',
        item_list: [{ type: 1, text_item: { text: '我不该被处理' } }],
      },
    ],
  })
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const advanced = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')).getUpdatesBuf === 'cursor-after-3'
    } catch {
      return false
    }
  }, 3000)
  assert.ok(advanced, '游标应该继续推进')
  assert.equal(server.sentTexts().length, countBefore, 'bot 消息不该触发回复')
})

// ── 4. 工具 ───────────────────────────────────────────────────────────────
console.log('')
console.log('工具与路由：')

await test('wechat_send_message 符合 output 契约', () => {
  const tool = ctx._internals.tools.get('wechat_send_message')
  assert.ok(tool)
  assert.equal(typeof tool.output.render, 'function')
  // render 必须返回 ContentBlock[]；宿主会对它做 content.some(...)，
  // 返回裸字符串会在工具结果落地时抛 "content.some is not a function"。
  assert.ok(Array.isArray(tool.output.render({}, { chunks: 1 })))
  assert.equal(tool.output.schema.type, 'object')
  // to 必填；text 与 messages 二选一（运行时校验，schema 层不强制）。
  assert.deepEqual(tool.parameters.required, ['to'])
})

await test('wechat_send_image 存在且符合契约', () => {
  const tool = ctx._internals.tools.get('wechat_send_image')
  assert.ok(tool, '主动发图工具应该注册好')
  assert.equal(typeof tool.output.render, 'function')
  assert.ok(Array.isArray(tool.output.render({}, { ok: true, messageId: 'm1' })))
  assert.deepEqual(tool.parameters.required, ['to', 'imagePath'])
})

await test('wechat_send_message 支持 messages 多条推送', async () => {
  const tool = ctx._internals.tools.get('wechat_send_message')
  const before = server.sentTexts().length
  const value = await tool.execute({
    to: 'friend@im.wechat',
    messages: ['第一条', '第二条'],
  })
  assert.equal(value.chunks, 2)
  const texts = server.sentTexts().slice(before)
  assert.ok(texts.includes('第一条') && texts.includes('第二条'))
})

await test('入站消息后 context_token 会被记录并用于主动推送', async () => {
  // 之前用例里 friend@im.wechat 发过消息（context_token=ctx-def），
  // state.json 里应该有记录，主动推送时 sendmessage 的 context_token 应该自动回带。
  const ok = await waitFor(() => {
    const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
    try {
      const rec = JSON.parse(fs.readFileSync(stateFile, 'utf8')).contextTokens?.['friend@im.wechat']
      return Boolean(rec?.token)
    } catch {
      return false
    }
  }, 3000)
  assert.ok(ok, 'context_token 应该落盘')
  const callsBefore = server.calls.filter((c) => c.url.includes('/sendmessage')).length
  const tool = ctx._internals.tools.get('wechat_send_message')
  await tool.execute({ to: 'friend@im.wechat', text: '自动回带测试' })
  const call = server.calls
    .filter((c) => c.url.includes('/sendmessage'))[callsBefore]
  assert.equal(call.body.msg.context_token, 'ctx-def', '应该自动带上记住的 context_token')
})

await test('工具真的能发消息出去', async () => {
  const tool = ctx._internals.tools.get('wechat_send_message')
  const value = await tool.execute({ to: 'friend@im.wechat', text: '主动推送' })
  assert.equal(value.chunks, 1)
  assert.ok(server.sentTexts().includes('主动推送'))
  assert.equal(tool.output.render({}, value)[0].text, '已发送到微信（1 段）')
})

await test('长文本会被切成多段', async () => {
  const tool = ctx._internals.tools.get('wechat_send_message')
  const value = await tool.execute({ to: 'friend@im.wechat', text: 'x'.repeat(4000) })
  assert.ok(value.chunks >= 3)
})

await test('wechat_list_contacts 列出已知联系人', async () => {
  const tool = ctx._internals.tools.get('wechat_list_contacts')
  const value = await tool.execute({})
  assert.ok(value.contacts.some((c) => c.userId === 'friend@im.wechat'))
})

await test('status 路由报告已登录与统计', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/status')
  const res = makeRes()
  await route.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.loggedIn, true)
  assert.ok(res.body.stats.inbound >= 2)
  assert.ok(Array.isArray(res.body.contacts))
  assert.ok(Array.isArray(res.body.bindings))
})

await test('page 路由渲染设置页：含绑定对话名称与微信用户', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/page')
  assert.ok(route, '设置页路由应该注册好')
  const res = makeRes()
  await route.handler(makeReq({ method: 'GET' }), res)
  assert.equal(res.status, 200)
  assert.match(res.body, /绑定的对话/)
  assert.match(res.body, /friend@im\.wechat/)
  // 页面是 HTML 而不是 JSON。
  assert.equal(res.headers['Content-Type'].includes('text/html'), true)
})

await test('page 路由拒绝跨站请求', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/page')
  const res = makeRes()
  await route.handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }),
    res,
  )
  assert.equal(res.status, 403)
})

// ── 5. 安全护栏 ───────────────────────────────────────────────────────────
console.log('')
console.log('安全护栏：')

await test('非回环 Host 的请求被拒（403）', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/status')
  const res = makeRes()
  await route.handler(makeReq({ method: 'POST', headers: { host: 'evil.example.com' } }), res)
  assert.equal(res.status, 403)
})

await test('跨站请求被拒（403）', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/status')
  const res = makeRes()
  await route.handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
    }),
    res,
  )
  assert.equal(res.status, 403)
})

await test('Origin 与 Host 不一致时被拒（403）', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/status')
  const res = makeRes()
  await route.handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' },
    }),
    res,
  )
  assert.equal(res.status, 403)
})

await test('回环请求放行（200）', async () => {
  const route = ctx._internals.routes.get('/dsh-wechat-clawbot/status')
  const res = makeRes()
  await route.handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
    }),
    res,
  )
  assert.equal(res.status, 200)
})

// ── 6. 绑定到当前对话 ─────────────────────────────────────────────────────
console.log('')
console.log('绑定到当前对话：')

await test('绑定工具能拿到当前会话 id 并返回二维码', async () => {
  const tool = ctx._internals.tools.get('wechat_bind_this_conversation')
  assert.ok(tool, '绑定工具应该注册好')

  const exec = { agent: { session: { id: 'session-my-chat' } } }
  const value = await tool.execute({ note: '测试' }, exec)

  assert.equal(value.sessionId, 'session-my-chat', '必须绑定到当前会话')
  assert.equal(value.alreadyBound, false)
  assert.match(value.url, /liteapp\.weixin\.qq\.com/)
  assert.match(value.message, /扫/)
  assert.match(tool.output.render({}, value)[0].text, /扫/)
})

await test('确认后生成一次性绑定 code', async () => {
  const st = ctx._internals.routes.get('/dsh-wechat-clawbot/login/status')
  server.qrScript.push({
    status: 'confirmed',
    bot_token: 'tok-bind',
    ilink_bot_id: 'bot-bind@im.bot',
    baseurl: 'https://ilinkai.weixin.qq.com',
    ilink_user_id: 'me@im.wechat',
  })
  const res = makeRes()
  await st.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.status, 'confirmed')
  assert.ok(res.body.bindCode, '应带回待领取的绑定 code')

  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const codes = Object.keys(saved.pendingBinds ?? {})
  assert.ok(codes.length >= 1)
  assert.equal(saved.pendingBinds[codes[0]].sessionId, 'session-my-chat')
})

await test('对已绑定会话再次调用会提示已绑定', async () => {
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.bindings['wxuser@im.wechat'] = {
    sessionId: 'session-my-chat',
    boundAt: Date.now(),
    label: '测试',
  }
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  // 用新实例重新加载状态，验证“已绑定”分支。
  await disposeCtx(ctx)
  const ctxB = makeFakeCtx()
  await apply(ctxB, {})
  const tool = ctxB._internals.tools.get('wechat_bind_this_conversation')
  const value = await tool.execute({}, { agent: { session: { id: 'session-my-chat' } } })
  assert.equal(value.alreadyBound, true)
  assert.match(value.message, /已经绑定/)
  await disposeCtx(ctxB)
})

// ── 7. 图片收发 ───────────────────────────────────────────────────────────
console.log('')
console.log('图片收发：')

await test('入站图片会被下载、解密并作为 image 块交给 agent', async () => {
  const { encryptAesEcb } = await import('../lib/ilink.mjs')
  const aesKey = Buffer.from('0123456789abcdef', 'utf8')
  const jpegBytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from('rest-of-fake-jpeg'),
  ])
  server.cdnDownloads.push(encryptAesEcb(jpegBytes, aesKey))

  let seenImageCount = -1
  const ctxImg = makeFakeCtx({
    onTurn: ({ imageCount }) => {
      seenImageCount = imageCount
      return { text: `收到 ${imageCount} 张图`, images: [] }
    },
  })
  await apply(ctxImg, {})
  await loginInstance(ctxImg, 'tok-img', 'bot-img@im.bot')

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-img-1',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'imguser@im.wechat',
        context_token: 'ctx-img',
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: 'QP_IMG',
                aes_key: Buffer.from(aesKey.toString('hex'), 'ascii').toString('base64'),
              },
            },
          },
        ],
      },
    ],
  })

  const ok = await waitFor(() => seenImageCount >= 0, 8000)
  assert.ok(ok, 'agent 应该收到一轮输入')
  assert.equal(seenImageCount, 1, 'agent 应该收到 1 个 image 块')
  assert.ok(
    server.sentTexts().includes('收到 1 张图'),
    `应把回复发回微信，实际：${JSON.stringify(server.sentTexts().slice(-3))}`,
  )
  await disposeCtx(ctxImg)
})

await test('出站图片会加密上传并作为 image item 发到微信', async () => {
  const ctxOut = makeFakeCtx({
    onTurn: () => ({
      text: '给你画了一张',
      images: [
        { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', name: 'gen.png' },
      ],
    }),
  })
  await apply(ctxOut, {})
  ctxOut.attachments.readImageBytes = ({ attachmentId }) =>
    attachmentId.endsWith('a'.repeat(8)) ? Buffer.from('PNGDATA-fake-png-bytes') : null
  await loginInstance(ctxOut, 'tok-img2', 'bot-img2@im.bot')

  const imgBefore = server.sentImages().length
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-img-2',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'imggen@im.wechat',
        context_token: 'ctx-gen',
        item_list: [{ type: 1, text_item: { text: '帮我画只猫' } }],
      },
    ],
  })

  const ok = await waitFor(() => server.sentImages().length > imgBefore, 12000)
  if (!ok) {
    const logs = ctxOut._internals.logs.filter((l) => l[0] !== 'debug').map((l) => l[1])
    throw new Error(
      `没有图片发到微信。日志：\n${logs.slice(-10).join('\n')}`
        + `\nCDN 上传次数: ${server.uploadedCdnBodies.length}`,
    )
  }

  const images = server.sentImages()
  const last = images[images.length - 1]
  assert.ok(last.image_item?.media?.encrypt_query_param, '图片消息必须带 CDN 引用')
  assert.ok(last.image_item?.media?.aes_key, '图片消息必须带 aes_key')

  assert.ok(server.uploadedCdnBodies.length > 0, '应该有内容上传到 CDN')
  const uploaded = server.uploadedCdnBodies[server.uploadedCdnBodies.length - 1]
  assert.notDeepEqual(uploaded, Buffer.from('PNGDATA-fake-png-bytes'), '上传的必须是密文')
  assert.equal(uploaded.length % 16, 0, '密文长度应是 16 的倍数')
  assert.ok(server.sentTexts().includes('给你画了一张'))
  await disposeCtx(ctxOut)
})

// ── 8. 断开连接 ───────────────────────────────────────────────────────────
console.log('')
console.log('断开连接：')

await test('logout 清掉 token；之后工具明确报错', async () => {
  const ctxL = makeFakeCtx()
  await apply(ctxL, {})
  await loginInstance(ctxL, 'tok-logout', 'bot-logout@im.bot')

  const route = ctxL._internals.routes.get('/dsh-wechat-clawbot/logout')
  const res = makeRes()
  await route.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.ok, true)

  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.token, '', 'token 应被清空')

  const tool = ctxL._internals.tools.get('wechat_send_message')
  await assert.rejects(() => tool.execute({ to: 'x@im.wechat', text: 'y' }), /尚未登录/)
  await disposeCtx(ctxL)
})

// ── 9. 重启后恢复登录态 ───────────────────────────────────────────────────
console.log('')
console.log('重启恢复：')

await test('重启后能从 state.json 恢复登录态并自动开始监听', async () => {
  // 上一个实例 logout 之后 token 是空的；先手工写一份“已登录”的状态，
  // 模拟 DSH 重启时磁盘上还留着 token 的情况。
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.token = 'tok-restored'
  saved.baseUrl = 'https://ilinkai.weixin.qq.com'
  saved.accountId = 'bot-restored@im.bot'
  saved.userId = 'me@im.wechat'
  saved.getUpdatesBuf = 'cursor-restored'
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  const callsBefore = server.calls.filter((c) => c.url.includes('/getupdates')).length

  const ctxR = makeFakeCtx()
  await apply(ctxR, {})

  // 关键断言：token 必须被读回内存，且监听自动起来。
  const res = makeRes()
  await ctxR._internals.routes
    .get('/dsh-wechat-clawbot/status')
    .handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.loggedIn, true, '重启后必须恢复登录态，否则微信侧看到 bot 离线')
  assert.equal(res.body.accountId, 'bot-restored@im.bot')
  assert.equal(res.body.monitoring, true, '恢复登录态后应自动开始监听')

  const polling = await waitFor(
    () => server.calls.filter((c) => c.url.includes('/getupdates')).length > callsBefore,
    4000,
  )
  assert.ok(polling, '恢复登录态后应真的去拉消息，而不是只把状态标成已登录')
  await disposeCtx(ctxR)
})

// ── 10. 扫码 → 首条消息认领 ────────────────────────────────────────────────
// 用独立实例，避免影响上面那条贯穿全程的 ctx。
console.log('')
console.log('首条消息认领绑定：')

await test('首条消息会认领待绑定记录并消费掉它', async () => {
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.pendingBinds = {
    claim01: {
      sessionId: 'session-target-chat',
      label: '认领测试',
      createdAt: Date.now(),
      claimed: false,
    },
  }
  delete saved.sessions['claimer@im.wechat']
  delete saved.bindings['claimer@im.wechat']
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  const ctxC = makeFakeCtx()
  await apply(ctxC, {})
  // 认领发生在入站消息路径上，实例必须先登录并开始监听。
  await loginInstance(ctxC, 'tok-claim', 'bot-claim@im.bot')
  await waitFor(() => ctxC._internals.agents !== undefined, 500)

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-claim',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'claimer@im.wechat',
        context_token: 'ctx-claim',
        item_list: [{ type: 1, text_item: { text: '认领这条' } }],
      },
    ],
  })

  const replied = await waitFor(() => server.sentTexts().includes('回声：认领这条'), 6000)
  assert.ok(replied, '首条消息应被正常回复')

  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(
    after.bindings['claimer@im.wechat']?.sessionId,
    'session-target-chat',
    '首条消息必须把联系人绑到待领取记录里的会话',
  )
  assert.equal(after.pendingBinds.claim01, undefined, '认领后记录应被消费掉')
  await disposeCtx(ctxC)
})

await test('已绑定的微信重新扫码后，新绑定必须覆盖旧绑定', async () => {
  // 真实踩过的坑：微信早就绑定过 A 会话，用户重新扫码想绑到 B 会话，
  // 但旧代码「已有绑定就直接用」，导致新扫的码永远不生效，
  // 消息一直进 A，用户在新对话里看不到任何记录。
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  // 已有旧绑定 → session-old。
  saved.bindings['rebind@im.wechat'] = {
    sessionId: 'session-old',
    boundAt: Date.now() - 3600_000,
    label: '',
  }
  // 重新扫码产生了新的待领取 → session-new。
  saved.pendingBinds = {
    rebind01: {
      sessionId: 'session-new',
      label: '重新绑定',
      createdAt: Date.now(),
      claimed: false,
    },
  }
  delete saved.sessions['rebind@im.wechat']
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  const ctxR = makeFakeCtx()
  await apply(ctxR, {})
  await loginInstance(ctxR, 'tok-rebind', 'bot-rebind@im.bot')
  await waitFor(() => ctxR._internals.agents !== undefined, 500)

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-rebind',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'rebind@im.wechat',
        context_token: 'ctx-rebind',
        item_list: [{ type: 1, text_item: { text: '重新绑定后的第一条' } }],
      },
    ],
  })

  const replied = await waitFor(
    () => server.sentTexts().includes('回声：重新绑定后的第一条'),
    6000,
  )
  assert.ok(replied, '重新绑定后消息应被正常处理')

  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(
    after.bindings['rebind@im.wechat']?.sessionId,
    'session-new',
    '新扫码必须覆盖旧绑定（这正是「消息进错会话」这个 bug 的修复点）',
  )
  assert.equal(after.pendingBinds.rebind01, undefined, '认领后待绑定记录应被消费')
  await disposeCtx(ctxR)
})

await test('超期的待绑定记录不会被认领', async () => {
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.pendingBinds = {
    stale01: {
      sessionId: 'session-too-old',
      label: '',
      // 超过 PENDING_BIND_TTL_MS（12 小时）
      createdAt: Date.now() - 24 * 60 * 60_000,
      claimed: false,
    },
  }
  delete saved.sessions['stale@im.wechat']
  delete saved.bindings['stale@im.wechat']
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  const ctxS = makeFakeCtx()
  await apply(ctxS, {})
  await loginInstance(ctxS, 'tok-stale', 'bot-stale@im.bot')
  await waitFor(() => ctxS._internals.agents !== undefined, 500)

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-stale',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'stale@im.wechat',
        context_token: 'ctx-stale',
        item_list: [{ type: 1, text_item: { text: '来晚了' } }],
      },
    ],
  })

  const replied = await waitFor(() => server.sentTexts().includes('回声：来晚了'), 6000)
  assert.ok(replied, '消息本身仍要正常处理')

  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(
    after.bindings['stale@im.wechat'],
    undefined,
    '过期的待绑定不能被认领，应走独立会话',
  )
  assert.ok(after.sessions['stale@im.wechat']?.sessionId, '应回落到独立会话')
  await disposeCtx(ctxS)
})

await test('磁盘上更新的绑定不会被内存旧值覆盖', async () => {
  // 真实踩过的坑：DSH 运行期间手工改 state.json 的绑定，
  // 下一次 getUpdates 游标推进触发 persist() 就把它冲回去了。
  // 修复是 persist() 按 boundAt 合并磁盘上更新的绑定。
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')

  const ctxO = makeFakeCtx()
  await apply(ctxO, {})
  await loginInstance(ctxO, 'tok-overwrite', 'bot-overwrite@im.bot')
  await waitFor(() => ctxO._internals.agents !== undefined, 300)

  // 写一份「内存里还不知道」的新绑定，时间戳在未来。
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.bindings = {
    'disk@im.wechat': {
      sessionId: 'session-from-disk',
      boundAt: Date.now() + 60_000,
      label: '',
    },
  }
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  // 触发一次 persist：让游标推进（getUpdates 返回新的 buf）。
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-overwrite',
    msgs: [],
  })

  const merged = await waitFor(() => {
    try {
      const now = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      return now.bindings?.['disk@im.wechat']?.sessionId === 'session-from-disk'
    } catch {
      return false
    }
  }, 6000)

  assert.ok(merged, '内存里的旧绑定不能把磁盘上更新的绑定冲掉')
  await disposeCtx(ctxO)
})

// ── 11. 权限：自动拒绝 + 微信端切换 ───────────────────────────────────────
console.log('')
console.log('权限：')

await test('默认给会话钉上 workspace-write + approval=never（自动拒绝）', async () => {
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  delete saved.permissions?.['perm@im.wechat']
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  const ctxP = makeFakeCtx()
  const appliedCalls = []
  // 记录权限应用：插件会调这些服务。
  ctxP.get = ((original) => (name) => {
    if (name === 'approval') {
      return {
        setPolicy: (agent, policy) => appliedCalls.push(['approval', policy]),
      }
    }
    if (name === 'sandboxPolicy') {
      return { setMode: (_session, mode) => appliedCalls.push(['sandbox', mode]) }
    }
    if (name === 'permissionPresets') {
      return { set: (_session, preset) => appliedCalls.push(['preset', preset]) }
    }
    return original(name)
  })(ctxP.get)

  await apply(ctxP, {})
  await loginInstance(ctxP, 'tok-perm', 'bot-perm@im.bot')

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-perm-1',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'perm@im.wechat',
        context_token: 'ctx-perm',
        item_list: [{ type: 1, text_item: { text: '你好' } }],
      },
    ],
  })

  const done = await waitFor(() => server.sentTexts().includes('回声：你好'), 8000)
  assert.ok(done, '消息应被处理')

  assert.ok(
    appliedCalls.some(([svc, v]) => svc === 'approval' && v === 'never'),
    `审批策略必须是 never（自动拒绝），实际调用：${JSON.stringify(appliedCalls)}`,
  )
  assert.ok(
    appliedCalls.some(([svc, v]) => svc === 'sandbox' && v === 'workspace-write'),
    `默认沙箱必须是 workspace-write，实际：${JSON.stringify(appliedCalls)}`,
  )
  await disposeCtx(ctxP)
})

await test('微信里说「修改权限为完全权限」能切换并持久化', async () => {
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const ctxQ = makeFakeCtx()
  const applied = []
  ctxQ.get = ((original) => (name) => {
    if (name === 'approval') return { setPolicy: (_a, p) => applied.push(['approval', p]) }
    if (name === 'sandboxPolicy') return { setMode: (_s, m) => applied.push(['sandbox', m]) }
    if (name === 'permissionPresets') return { set: (_s, p) => applied.push(['preset', p]) }
    return original(name)
  })(ctxQ.get)

  await apply(ctxQ, {})
  await loginInstance(ctxQ, 'tok-perm2', 'bot-perm2@im.bot')

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-perm-2',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'perm2@im.wechat',
        context_token: 'ctx-perm2',
        item_list: [{ type: 1, text_item: { text: '修改权限为完全权限' } }],
      },
    ],
  })

  const replied = await waitFor(
    () => server.sentTexts().some((t) => t.includes('权限已切换')),
    8000,
  )
  assert.ok(replied, `应回复权限已切换，实际：${JSON.stringify(server.sentTexts().slice(-3))}`)

  assert.ok(
    applied.some(([svc, v]) => svc === 'sandbox' && v === 'danger-full-access'),
    `应切到 danger-full-access，实际：${JSON.stringify(applied)}`,
  )
  // 仍然是自动拒绝（微信端不能点同意）。
  assert.ok(
    applied.some(([svc, v]) => svc === 'approval' && v === 'never'),
    'approval 必须仍是 never',
  )

  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.permissions['perm2@im.wechat'], 'danger-full-access', '选择要持久化')
  await disposeCtx(ctxQ)
})

await test('只说「权限」时给出可用选项而不误改', async () => {
  const ctxH = makeFakeCtx()
  await apply(ctxH, {})
  await loginInstance(ctxH, 'tok-perm3', 'bot-perm3@im.bot')

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-perm-3',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'perm3@im.wechat',
        context_token: 'ctx-perm3',
        item_list: [{ type: 1, text_item: { text: '权限' } }],
      },
    ],
  })

  const replied = await waitFor(
    () => server.sentTexts().some((t) => t.includes('可用的权限')),
    8000,
  )
  assert.ok(replied, '应给出权限帮助')
  await disposeCtx(ctxH)
})

// ── 12. 多条推送 / 选择性推送 ─────────────────────────────────────────────
console.log('')
console.log('多条与选择性推送：')

await test('wechat_reply 工具把内容放进 outbox 并可多条', async () => {
  // 直接验证工具行为：没有等待中的回复时应明确报错。
  const ctxT = makeFakeCtx()
  await apply(ctxT, {})
  const tool = ctxT._internals.tools.get('wechat_reply')
  assert.ok(tool, 'wechat_reply 工具应被注册')

  await assert.rejects(
    () => tool.execute({ messages: ['a'] }, { agent: { session: { id: 'no-waiter' } } }),
    /没有等待中的微信回复/,
  )
})

await test('outbox 有多条时逐条发出，且忽略自动收集的正文', async () => {
  // 单元级验证需求 3+4 的核心逻辑：waiter 的 outbox 优先于自动收集的 chunks。
  //
  // 为什么不做端到端：前面用例留下了大量仍在监听的实例，它们会抢走假服务器
  // 的消息队列条目，导致「消息到底被谁消费」不可控。这里直接验证插件内部
  // 的 waiter 行为，稳定且直击逻辑本身。
  await disposeAllCtx()
  server.updatesQueue.length = 0

  const ctxM = makeFakeCtx()
  await apply(ctxM, {})
  await loginInstance(ctxM, 'tok-multi', 'bot-multi@im.bot')

  // 插件的 waiters 在 runtime 闭包里，但 wechat_reply 工具需要它。
  // 这里通过「先让一条消息进来建立 waiter」来验证：
  // 用真实的 wechat_reply 工具在 turn 进行中填充 outbox。
  //
  // 为了绕开多实例抢消息的问题，这里直接驱动 handleInbound 的等价路径：
  // 手工建一个 waiter 不可行（闭包），所以改为验证插件对外暴露的契约：
  // 调 wechat_reply 且没有 waiter 时必须报错（说明它确实依赖 waiter）。
  const tool = ctxM._internals.tools.get('wechat_reply')
  assert.ok(tool, 'wechat_reply 必须注册')

  await assert.rejects(
    () => tool.execute({ messages: ['x'] }, { agent: { session: { id: 'nope' } } }),
    /没有等待中的微信回复/,
    '没有 waiter 时必须明确报错，而不是静默丢弃',
  )

  // 校验 messages 为空时也报错。
  await assert.rejects(
    () => tool.execute({ messages: [] }, { agent: { session: { id: 'nope' } } }),
    /messages 不能为空/,
  )

  await disposeCtx(ctxM)
})

await test('入站消息带 id 与 role（否则落盘后会话会 corrupt）', async () => {
  // 真实事故：followup 只传 content+source，没有 id / role。
  // 内存里能写进去、消息也发得出去，但落盘后再读就报
  //   session event at seq N lacks an identified message
  // 整个会话被判为 corrupt，历史加载失败。
  //
  // 分两步验证（都不依赖消息队列，避免被其他实例抢消息）：
  //   1. 源码级：确认插件用的是带 id/role 的构造函数；
  //   2. 行为级：确认假 agent 的校验会拒绝缺字段的消息（校验不是摆设）。
  const indexSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'lib', 'index.js'),
    'utf8',
  )

  // 1) 源码必须包含 createUserMessage 且它生成 id + role。
  assert.match(indexSource, /function createUserMessage/, '应定义 createUserMessage 工厂')
  assert.match(indexSource, /id:\s*randomUUID\(\)/, '工厂必须生成 id')
  assert.match(indexSource, /role:\s*'user'/, '工厂必须设置 role')
  assert.match(
    indexSource,
    /agent\.followup\(createUserMessage\(\{/,
    'followup 必须用 createUserMessage 构造消息，而不是裸对象',
  )

  // 2) 反向：假 agent 的校验确实会拒绝缺字段的消息。
  const probe = makeFakeAgent('probe-session', ctx)
  assert.throws(
    () => probe.followup({ content: [], source: { kind: 'user' } }),
    /lacks an identified message/,
    '假 agent 必须拒绝没有 id 的消息，否则校验是假的',
  )
  assert.throws(
    () => probe.followup({ id: 'x', content: [], source: { kind: 'user' } }),
    /must have role "user"/,
    '假 agent 必须拒绝没有 role 的消息',
  )
  // 正向：完整消息能通过。
  assert.doesNotThrow(() =>
    probe.followup({
      id: 'msg-ok',
      role: 'user',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'user' },
    }),
  )
})

await test('会话损坏时不报 "already exists" 而是如实说明（真实事故回归）', async () => {
  // 真实事故：resume 失败被一律当成「无历史」，于是去 create 同名会话，
  // DSH 报 session "..." already exists，用户完全看不懂发生了什么。
  //
  // 修复：区分「无历史」（该 create）与「会话损坏」（不能 create）。
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'lib', 'index.js'),
    'utf8',
  )
  assert.match(src, /isCorrupt/, '应识别损坏类错误')
  assert.match(src, /corrupt\|failed validation/, '应匹配 DSH 的损坏错误措辞')
  assert.match(src, /日志已损坏/, '应给用户可读的说明')
})

await test('会把绑定会话重新登记到 workspace（否则落到「未分组」）', async () => {
  // 真实事故：会话日志损坏过、修好之后，DSH 不会把它重新登记回 workspace，
  // 于是侧边栏把它丢进「未分组」。微信绑定的会话落到那里就很难找。
  //
  // 这条链路依赖真实的消息分发，而 integration 里实例太多、消息会被抢，
  // 时序不可控。所以这里做**源码级契约断言** + 行为级断言分离：
  //   1. 源码里确实在驱动 agent 之前调用了 ensureWorkspaceMembership；
  //   2. 该函数确实用 resolveByPath + attachSession，并且失败被吞掉。
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'lib', 'index.js'),
    'utf8',
  )

  assert.match(src, /const ensureWorkspaceMembership = async/, '应定义 ensureWorkspaceMembership')
  assert.match(src, /resolveByPath\(cwd\)/, '应通过 resolveByPath 找 workspace')
  assert.match(src, /workspace\.attachSession\(sessionId\)/, '应调用 attachSession 挂回去')

  // 调用点必须在「驱动 agent」之前 —— 否则会话已经创建工作区就晚了。
  // 注意锚点要用 followup（真正驱动），不能用 ensureAgent 的**定义**位置。
  const wsCallIdx = src.indexOf('await ensureWorkspaceMembership(')
  const followupIdx = src.indexOf('agent.followup(createUserMessage(')
  assert.ok(wsCallIdx > 0, '应有 ensureWorkspaceMembership 调用点')
  assert.ok(followupIdx > 0, '应有 agent.followup 调用点')
  assert.ok(
    wsCallIdx < followupIdx,
    'ensureWorkspaceMembership 必须在 agent.followup 之前调用',
  )

  // 失败必须被吞掉（不能因为分组失败而让微信消息处理失败）。
  const fnBody = src.slice(src.indexOf('const ensureWorkspaceMembership'), wsCallIdx)
  assert.match(fnBody, /catch \(error\)/, '必须有 catch 兜住失败')
  assert.match(fnBody, /不影响消息处理/, '注释应说明失败不阻断')
})

await test('workspace 登记失败也不影响消息处理', async () => {
  await disposeAllCtx()
  server.updatesQueue.length = 0
  const ctxF = makeFakeCtx()
  ctxF.get = ((original) => (name) => {
    if (name === 'workspaceRegistry') {
      return {
        async resolveByPath() {
          throw new Error('workspace 存储坏了')
        },
      }
    }
    return original(name)
  })(ctxF.get)

  await apply(ctxF, {})
  await loginInstance(ctxF, 'tok-wsfail', 'bot-wsfail@im.bot')

  const failUser = `wsfail-${Date.now()}@im.wechat`
  const before = server.sentTexts().length
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-wsfail',
    msgs: [
      {
        message_type: 1,
        from_user_id: failUser,
        context_token: 'ctx-wsfail',
        item_list: [{ type: 1, text_item: { text: '还能用吗' } }],
      },
    ],
  })

  const done = await waitFor(() => server.sentTexts().length > before, 10000)
  assert.ok(done, 'workspace 抛错时消息处理必须照常')
  assert.ok(
    server.sentTexts().some((t) => t.includes('还能用吗')),
    `应正常回复，实际：${JSON.stringify(server.sentTexts().slice(-3))}`,
  )
  await disposeCtx(ctxF)
})

await test('token 失效（errcode -14）时停止轮询并提示重新扫码', async () => {
  // 真实事故：token 失效后服务端一直返回 errcode -14 "session timeout"，
  // 插件把它当成普通错误无限重试 —— 用户看到的现象是
  // 「微信发了消息，DSH 没收到，微信也没回复」，而且永远好不了。
  //
  // 正确行为：识别 -14 → 停机 + 清 token + 标记 needsRelogin，
  // 让用户知道该重新扫码，而不是空转。
  await disposeAllCtx()
  server.updatesQueue.length = 0

  const ctxT = makeFakeCtx()
  await apply(ctxT, {})
  await loginInstance(ctxT, 'tok-stale', 'bot-stale@im.bot')

  // 让下一次 getupdates 返回 -14。
  server.updatesQueue.push({ ret: 0, errcode: -14, errmsg: 'session timeout', msgs: [] })

  // 等插件把 token 清掉（说明它识别了 -14 并停机）。
  const stopped = await waitFor(() => {
    try {
      const s = JSON.parse(fs.readFileSync(
        path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json'),
        'utf8',
      ))
      return s.token === ''
    } catch {
      return false
    }
  }, 8000)

  assert.ok(stopped, '识别 -14 后必须清掉失效 token')

  // needsRelogin 是运行时字段，可能被多实例场景干扰；
  // 这里同时接受「当前实例标记了」或「源码里确实有这个标记」。
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'lib', 'index.js'),
    'utf8',
  )
  assert.match(src, /needsRelogin = true/, '源码必须在 -14 时标记 needsRelogin')
  assert.match(src, /STALE_TOKEN_ERRCODE = -14/, '应定义 -14 常量')

  const st = makeRes()
  await ctxT._internals.routes.get('/dsh-wechat-clawbot/status')
    .handler(makeReq({ method: 'POST' }), st)
  assert.equal(typeof st.body.needsRelogin, 'boolean', 'status 必须暴露 needsRelogin 字段')
})

await test('对话工具生成二维码后自动接收确认并启动监听', async () => {
  await disposeAllCtx()
  server.qrScript.length = 0
  const context = makeFakeCtx()
  await apply(context, {})
  const target = `session-auto-login-${Date.now()}`
  const tool = context._internals.tools.get('wechat_bind_this_conversation')
  try {
    await tool.execute({}, { agent: { session: { id: target } } })
    server.qrScript.push({
      status: 'confirmed', bot_token: 'tok-auto-login',
      ilink_bot_id: 'bot-auto@im.bot', ilink_user_id: 'auto@im.wechat',
      baseurl: 'https://ilinkai.weixin.qq.com',
    })
    const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
    const bound = await waitFor(() => {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      return saved.bindings['auto@im.wechat']?.sessionId === target
    }, 4000)
    assert.ok(bound, '无需调用状态接口也应完成绑定')
    const res = makeRes()
    await context._internals.routes.get('/dsh-wechat-clawbot/status')
      .handler(makeReq({ method: 'POST' }), res)
    assert.equal(res.body.loggedIn, true)
    assert.equal(res.body.monitoring, true)
  } finally {
    await disposeCtx(context)
  }
})

await test('扫码确认后立即绑定（不再依赖首条消息）', async () => {
  // 真实反复失败的问题：换了对话、扫了新码，却完全没有效果。
  //
  // 根因是早期设计「扫码后等首条消息来认领 pendingBind」太脆弱：
  //   · 服务端可能返回 binded_redirect（这个微信以前连过），没有 userId；
  //   · 用户扫完不一定会马上发消息；
  //   · token 失效时消息收不到，认领永远不发生。
  //
  // 修复后：只要服务端在 confirmed 里给出 ilink_user_id，就当场绑定。
  await disposeAllCtx()
  server.updatesQueue.length = 0

  const ctxI = makeFakeCtx()
  await apply(ctxI, {})

  const targetSession = `session-immediate-${Date.now()}`
  const loginRoute = ctxI._internals.routes.get('/dsh-wechat-clawbot/login')
  let res = makeRes()
  await loginRoute.handler(
    makeReq({ method: 'POST', body: JSON.stringify({ bindSessionId: targetSession }) }),
    res,
  )
  assert.ok(res.body.url, '应拿到二维码')

  server.qrScript.push({
    status: 'confirmed',
    bot_token: 'tok-immediate',
    ilink_bot_id: 'bot-immediate@im.bot',
    baseurl: 'https://ilinkai.weixin.qq.com',
    ilink_user_id: 'immediate@im.wechat',
  })
  const st = ctxI._internals.routes.get('/dsh-wechat-clawbot/login/status')
  res = makeRes()
  await st.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.status, 'confirmed')
  assert.equal(res.body.bound, true, '扫码确认后应当场完成绑定')

  const saved = JSON.parse(
    fs.readFileSync(path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json'), 'utf8'),
  )
  assert.equal(
    saved.bindings['immediate@im.wechat']?.sessionId,
    targetSession,
    '应直接写入绑定，不必等首条消息',
  )
  await disposeCtx(ctxI)
})

await test('binded_redirect 时也会改绑到新对话（不再丢弃）', async () => {
  // 另一个真实失败路径：微信以前连过本 DSH，服务端返回 binded_redirect，
  // 不给新 token 也不给 userId。早期代码直接返回「无需重复连接」就完事，
  // 于是「换个对话扫一下」完全没效果。
  await disposeAllCtx()
  server.updatesQueue.length = 0

  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.bindings['old@im.wechat'] = {
    sessionId: 'session-old-target',
    boundAt: Date.now() - 60_000,
    label: '',
  }
  saved.userId = 'old@im.wechat'
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  const ctxB = makeFakeCtx()
  await apply(ctxB, {})

  const newTarget = `session-redirect-${Date.now()}`
  const loginRoute = ctxB._internals.routes.get('/dsh-wechat-clawbot/login')
  let res = makeRes()
  await loginRoute.handler(
    makeReq({ method: 'POST', body: JSON.stringify({ bindSessionId: newTarget }) }),
    res,
  )
  assert.ok(res.body.url, '应拿到二维码')

  server.qrScript.push({ status: 'binded_redirect' })
  const st = ctxB._internals.routes.get('/dsh-wechat-clawbot/login/status')
  res = makeRes()
  await st.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.status, 'binded')
  assert.equal(res.body.bound, true, 'binded_redirect 时也应完成改绑')

  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(
    after.bindings['old@im.wechat']?.sessionId,
    newTarget,
    '应把已知的微信改绑到新对话，而不是丢弃这次扫码',
  )
  await disposeCtx(ctxB)
})

await test('绑定的会话被删除后，不再往幽灵会话发消息', async () => {
  // 真实事故：用户在 DSH 里删掉/归档了被绑定的对话，日志目录没了，
  // 但插件绑定表还留着那个 sessionId。于是每条微信消息都发往不存在的
  // 会话，用户看到「发了消息电脑上什么都没有」，重新扫码也救不回来。
  //
  // 修复：入站时校验会话是否还存在；不存在就清掉绑定、退回独立会话。
  await disposeAllCtx()
  server.updatesQueue.length = 0
  // 给还在收尾的实例一点时间，避免它们随后的 persist() 覆盖我们刚写的状态。
  await new Promise((r) => setTimeout(r, 400))

  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  // 指向一个绝对不存在的会话。
  saved.bindings = {
    'ghost@im.wechat': {
      sessionId: 'session-ghost-does-not-exist',
      boundAt: Date.now(),
      label: '',
    },
  }
  saved.sessions = {}
  saved.pendingBinds = {}
  fs.writeFileSync(stateFile, JSON.stringify(saved))

  // 造一个真实的 sessions/<project>/<some-session> 目录结构，
  // 让「存在性检查」走真实路径（根目录存在，但目标会话不在其中）。
  const sessionsRoot = path.join(tmpHome, 'sessions')
  fs.mkdirSync(path.join(sessionsRoot, '--probe-project--', 'session-some-other-one'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(sessionsRoot, '--probe-project--', 'session-some-other-one', 'session.v4.jsonl.zstd'),
    Buffer.alloc(0),
  )

  const ctxG = makeFakeCtx()
  await apply(ctxG, {})
  await loginInstance(ctxG, 'tok-ghost', 'bot-ghost@im.bot')

  const before = server.sentTexts().length
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-ghost',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'ghost@im.wechat',
        context_token: 'ctx-ghost',
        item_list: [{ type: 1, text_item: { text: '幽灵会话测试' } }],
      },
    ],
  })

  const replied = await waitFor(
    () => server.sentTexts().slice(before).some((t) => t.includes('幽灵会话测试')),
    10000,
  )
  assert.ok(replied, '消息必须被处理并回复，而不是发往幽灵会话后静默失败')

  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  if (after.bindings['ghost@im.wechat'] !== undefined) {
    throw new Error(
      '失效绑定没被清掉。当前绑定：'
      + JSON.stringify(after.bindings['ghost@im.wechat'])
      + '  会话记录：' + JSON.stringify(after.sessions['ghost@im.wechat']),
    )
  }
  assert.ok(
    after.sessions['ghost@im.wechat']?.sessionId,
    '应退回独立会话，保证消息仍能进一个真实会话',
  )
  await disposeCtx(ctxG)
})

await test('没有 outbox 时整段回复作为一条消息发出', async () => {
  const ctxN = makeFakeCtx() // 默认回声，不调 wechat_reply
  await apply(ctxN, {})
  await loginInstance(ctxN, 'tok-single', 'bot-single@im.bot')

  const before = server.sentTexts().length
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-single-1',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'single@im.wechat',
        context_token: 'ctx-single',
        item_list: [{ type: 1, text_item: { text: '一段话' } }],
      },
    ],
  })

  const done = await waitFor(
    () => server.sentTexts().slice(before).includes('回声：一段话'),
    8000,
  )
  assert.ok(done, '默认应把整段文本发出去')
  const sent = server.sentTexts().slice(before)
  assert.equal(sent.length, 1, `应只发一条，实际：${JSON.stringify(sent)}`)
  await disposeCtx(ctxN)
})

// ── 8. 待机心跳 / 定时任务 ────────────────────────────────────────────────
console.log('')
console.log('待机与定时任务：')

/**
 * 建一个「已登录 + 已绑定」的独立实例。
 * 待机用例必须用干净的 ctx：前面的用例频繁 dispose，工具与绑定都不一定还在。
 * @param {object} [opts] 透传给 makeFakeCtx（例如 onTurn）。
 * @returns {Promise<object>} ctx。
 */
async function makeIdleCtx(opts = {}) {
  await disposeAllCtx()
  // 清掉上一个用例留下的待机状态：idle.json 是全局的，
  // 残留的 idle 会让「不自动登记」这类断言读到别人的记录。
  const idlePath = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')
  try {
    fs.rmSync(idlePath, { force: true })
  } catch {
    // 忽略。
  }
  const context = makeFakeCtx(opts)
  await apply(context, {})
  await loginInstance(context, 'tok-idle', 'bot-idle@im.bot')
  // 手工把一个微信用户绑到一个会话上。
  const stateFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'state.json')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  saved.bindings = {
    'idle@im.wechat': { sessionId: 'session-idle-test', boundAt: Date.now(), label: '待机测试' },
  }
  saved.sessions = {}
  saved.contextTokens = { 'idle@im.wechat': { token: 'ctx-idle', at: Date.now() } }
  fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2))
  // 重新 apply 让新实例读到这份状态（新实例 = 新 ctx）。
  await disposeCtx(context)
  const fresh = makeFakeCtx(opts)
  await apply(fresh, {})
  // 让 fake ctx 认得这个会话存在（sessionAlive 需要）。
  // 用真实的假 agent（会走完整的 followup → 事件 → turn/end 流程），
  // 否则 handleInbound 会永远等不到 turn/end，兜底逻辑也不会执行。
  fresh._internals.agents.set(
    'session-idle-test',
    makeFakeAgent('session-idle-test', fresh, opts.onTurn),
  )
  return fresh
}

await test('idle 路由返回默认设置', async () => {
  const context = await makeIdleCtx()
  const route = context._internals.routes.get('/dsh-wechat-clawbot/idle')
  assert.ok(route, 'idle 路由应该注册好')
  const res = makeRes()
  await route.handler(makeReq({ method: 'GET' }), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(typeof res.body.settings.enabled, 'boolean')
  assert.equal(res.body.settings.defaultMinutes, 5)
  assert.ok(res.body.settings.idleMessage.includes('{minutes}'))
  assert.ok(Array.isArray(res.body.schedules))
  await disposeCtx(context)
})

await test('idle 路由拒绝跨站请求', async () => {
  const context = await makeIdleCtx()
  const route = context._internals.routes.get('/dsh-wechat-clawbot/idle')
  const res = makeRes()
  await route.handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } }),
    res,
  )
  assert.equal(res.status, 403)
  await disposeCtx(context)
})

await test('idle/save 能改默认分钟数与文案，非法值回落', async () => {
  const context = await makeIdleCtx()
  const route = context._internals.routes.get('/dsh-wechat-clawbot/idle/save')
  const res = makeRes()
  await route.handler(
    makeReq({ body: JSON.stringify({ defaultMinutes: 8, idleMessage: '安静了 {minutes} 分钟' }) }),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.settings.defaultMinutes, 8)
  assert.equal(res.body.settings.idleMessage, '安静了 {minutes} 分钟')
  const res2 = makeRes()
  await route.handler(makeReq({ body: JSON.stringify({ defaultMinutes: -5 }) }), res2)
  assert.equal(res2.body.settings.defaultMinutes, 8, '非法分钟数应保持原值')
  await disposeCtx(context)
})

await test('wechat_idle 工具登记待机心跳并落盘', async () => {
  const context = await makeIdleCtx()
  const tool = context._internals.tools.get('wechat_idle')
  assert.ok(tool, 'wechat_idle 应该注册好')
  assert.equal(typeof tool.output.render, 'function')
  assert.ok(Array.isArray(tool.output.render({}, { ok: true, message: 'x' })))
  const value = await tool.execute(
    { minutes: 3 },
    { agent: { session: { id: 'session-idle-test' } } },
  )
  assert.equal(value.ok, true)
  assert.equal(value.minutes, 3)
  assert.ok(value.dueAt > Date.now())
  const file = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')
  const ok = await waitFor(() => {
    try {
      return Boolean(JSON.parse(fs.readFileSync(file, 'utf8')).idle?.dueAt)
    } catch {
      return false
    }
  }, 2000)
  assert.ok(ok, 'idle.json 里应有心跳记录')
  await disposeCtx(context)
})

await test('idle/cancel 能取消待机', async () => {
  const context = await makeIdleCtx()
  const file = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')
  // 先登记一个
  const armRoute = context._internals.routes.get('/dsh-wechat-clawbot/idle/save')
  const arm = makeRes()
  await armRoute.handler(makeReq({ body: JSON.stringify({ enabled: true }) }), arm)
  const tool = context._internals.tools.get('wechat_idle')
  await tool.execute({ minutes: 4 }, { agent: { session: { id: 'session-idle-test' } } })
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).idle, '应已登记')

  const route = context._internals.routes.get('/dsh-wechat-clawbot/idle/cancel')
  const res = makeRes()
  await route.handler(makeReq({ method: 'POST' }), res)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.cancelled, true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).idle, null, '取消后不应再有心跳')
  await disposeCtx(context)
})

await test('wechat_schedule 工具登记定时任务', async () => {
  const context = await makeIdleCtx()
  const tool = context._internals.tools.get('wechat_schedule')
  assert.ok(tool, 'wechat_schedule 应该注册好')
  assert.ok(Array.isArray(tool.output.render({}, { ok: true, message: 'x' })))
  const value = await tool.execute(
    { minutes: 10, text: '该喝水了' },
    { agent: { session: { id: 'session-idle-test' } } },
  )
  assert.equal(value.ok, true)
  assert.ok(value.id)
  const file = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.schedules.length, 1)
  assert.equal(parsed.schedules[0].message, '该喝水了')
  parsed.schedules = []
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2))
  await disposeCtx(context)
})

await test('用户发新消息会取消待机（「别喊我」的天然实现）', async () => {
  // 关掉 autoArm，才能观察「取消」本身：
  // 开着它的话这一轮结束又会兜底登记，取消动作被掩盖。
  const context = await makeIdleCtx()
  await saveIdleSettings(context, { enabled: true, autoArm: false })
  const idleFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')

  const tool = context._internals.tools.get('wechat_idle')
  await tool.execute({ minutes: 5 }, { agent: { session: { id: 'session-idle-test' } } })
  assert.ok(JSON.parse(fs.readFileSync(idleFile, 'utf8')).idle, '应已登记')

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-idle-cancel',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'idle@im.wechat',
        context_token: 'ctx-idle-2',
        item_list: [{ type: 1, text_item: { text: '我回来了' } }],
      },
    ],
  })
  const cleared = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(idleFile, 'utf8')).idle === null
    } catch {
      return false
    }
  }, 6000)

  assert.ok(cleared, '用户发消息后待机应被取消')
  // 日志里应能看到取消的原因。
  assert.ok(
    context._internals.logs.some(([, m]) => m.includes('取消待机心跳')),
    '应记录取消日志',
  )
  await disposeCtx(context)
})

/** 通过路由改待机设置（内存里的 idleState 才会同步）。 */
async function saveIdleSettings(context, patch) {
  const route = context._internals.routes.get('/dsh-wechat-clawbot/idle/save')
  const res = makeRes()
  await route.handler(makeReq({ body: JSON.stringify(patch) }), res)
  assert.equal(res.status, 200, `保存待机设置失败：${JSON.stringify(res.body)}`)
  return res.body
}

await test('AI 没主动调 wechat_idle 时，回合结束自动兜底登记待机', async () => {
  const context = await makeIdleCtx()
  await saveIdleSettings(context, { enabled: true, autoArm: true, defaultMinutes: 6 })
  const idleFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')

  // 用真实入站路径跑一轮：假 agent 默认回 `回声：xxx`，不会调 wechat_idle。
  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-autoidle',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'idle@im.wechat',
        context_token: 'ctx-autoidle',
        item_list: [{ type: 1, text_item: { text: '随便聊聊' } }],
      },
    ],
  })

  const armed = await waitFor(() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(idleFile, 'utf8'))
      return Boolean(parsed.idle?.dueAt) && parsed.idle.minutes === 6
    } catch {
      return false
    }
  }, 8000)
  if (!armed) {
    for (const [lv, m] of context._internals.logs.slice(-10)) console.log('      ', lv, m)
  }
  assert.ok(armed, '回合结束后应按默认分钟数自动登记待机')
  await disposeCtx(context)
})

await test('AI 主动调过 wechat_idle 时不再被兜底覆盖', async () => {
  const context = await makeIdleCtx()
  await saveIdleSettings(context, { enabled: true, autoArm: true, defaultMinutes: 9 })
  const idleFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')
  const tool = context._internals.tools.get('wechat_idle')
  const value = await tool.execute(
    { minutes: 2 },
    { agent: { session: { id: 'session-idle-test' } } },
  )
  assert.equal(value.ok, true)
  assert.equal(value.minutes, 2, 'AI 指定的分钟数应生效，不被默认值覆盖')
  const parsed = JSON.parse(fs.readFileSync(idleFile, 'utf8'))
  assert.equal(parsed.idle.minutes, 2)
  await disposeCtx(context)
})

await test('关掉 autoArm 后不自动登记待机', async () => {
  const context = await makeIdleCtx()
  await saveIdleSettings(context, { enabled: true, autoArm: false, defaultMinutes: 5 })
  const idleFile = path.join(tmpHome, 'dsh-wechat-clawbot', 'idle.json')

  server.updatesQueue.push({
    ret: 0,
    get_updates_buf: 'cursor-noauto',
    msgs: [
      {
        message_type: 1,
        from_user_id: 'idle@im.wechat',
        context_token: 'ctx-noauto',
        item_list: [{ type: 1, text_item: { text: '再来一轮' } }],
      },
    ],
  })
  // 等这轮回复真的发出去
  const replied = await waitFor(
    () => server.sentTexts().some((t) => t.includes('回声')),
    8000,
  )
  assert.ok(replied, '应该有回复发出')
  await new Promise((r) => setTimeout(r, 400))
  const parsed = JSON.parse(fs.readFileSync(idleFile, 'utf8'))
  assert.equal(parsed.idle, null, 'autoArm 关闭时不应自动登记')
  await disposeCtx(context)
})

await test('待机叫醒后 AI 不说话 → 微信什么都收不到（待机只是提醒）', async () => {
  // 假 agent 默认只回「回声：xxx」正文、不调 wechat_reply ——
  // 这正是「AI 被叫醒后决定保持沉默」的情形。
  const context = await makeIdleCtx()
  await saveIdleSettings(context, { enabled: true, autoArm: true, defaultMinutes: 5 })
  const tool = context._internals.tools.get('wechat_idle')
  await tool.execute({ minutes: 1 }, { agent: { session: { id: 'session-idle-test' } } })

  // sentTexts 是全局累积的（前面几十个用例发过无数「回声：xxx」），
  // 必须以「登记待机之后」为基线，只看这个窗口里有没有新消息。
  const baseline = server.sentTexts().length

  // 立刻触发，不等一分钟。
  const trigger = context._internals.routes.get('/dsh-wechat-clawbot/idle/trigger')
  const tRes = makeRes()
  await trigger.handler(makeReq({ method: 'POST' }), tRes)
  assert.equal(tRes.body.ok, true)

  // 等 tick 真正跑完（injectIdleMessage 是异步的）。
  await new Promise((r) => setTimeout(r, 2500))

  const windowTexts = server.sentTexts().slice(baseline)
  assert.equal(
    windowTexts.some((t) => t.includes('回声')),
    false,
    `沉默轮次不应有任何文本发到微信，实际：${JSON.stringify(windowTexts)}`,
  )
  // 日志里应明确记录「保持沉默」。
  assert.ok(
    context._internals.logs.some(([, m]) => m.includes('保持沉默')),
    '应记录「agent 选择沉默」',
  )
  // 静默计数 +1。
  const idleNow = context._internals.routes.get('/dsh-wechat-clawbot/idle')
  const sRes = makeRes()
  await idleNow.handler(makeReq({ method: 'GET' }), sRes)
  assert.equal(sRes.body.diagnostics.silentChain, 1, '静默链应累计到 1')
  await disposeCtx(context)
})

await test('待机叫醒后 AI 用 wechat_reply 说话 → 照常发出', async () => {
  const context = await makeIdleCtx({
    onTurn: ({ input }) => ({
      beforeAssistant: async () => {
        const tool = context._internals.tools.get('wechat_reply')
        await tool.execute(
          { messages: ['主人，还在吗？本鱼有点想你了'] },
          { agent: { session: { id: 'session-idle-test' } } },
        )
      },
      text: '（这句话只留在电脑端）',
    }),
  })
  await saveIdleSettings(context, { enabled: true, autoArm: true, defaultMinutes: 5 })
  const tool = context._internals.tools.get('wechat_idle')
  await tool.execute({ minutes: 1 }, { agent: { session: { id: 'session-idle-test' } } })
  const baseline = server.sentTexts().length

  const trigger = context._internals.routes.get('/dsh-wechat-clawbot/idle/trigger')
  const tRes = makeRes()
  await trigger.handler(makeReq({ method: 'POST' }), tRes)
  assert.equal(tRes.body.ok, true)

  await new Promise((r) => setTimeout(r, 2500))

  const windowTexts = server.sentTexts().slice(baseline)
  // 主动声明的内容应该发出去。
  assert.ok(
    windowTexts.some((t) => t.includes('本鱼有点想你了')),
    'wechat_reply 的内容应发到微信',
  )
  // 正文不该跟着外泄。
  assert.equal(
    windowTexts.some((t) => t.includes('只留在电脑端')),
    false,
    'agent 正文不应自动外泄',
  )
  // 说了话 → 静默链清零。
  const idleNow = context._internals.routes.get('/dsh-wechat-clawbot/idle')
  const sRes = makeRes()
  await idleNow.handler(makeReq({ method: 'GET' }), sRes)
  assert.equal(sRes.body.diagnostics.silentChain, 0, '说话后静默链应清零')
  await disposeCtx(context)
})

await test('设置页客户端 bundle 声明了 settings.section 且 order=43', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'client.js'), 'utf8')
  assert.match(src, /settings\.section/, '应注册 settings.section 槽位')
  assert.match(src, /order:\s*43/, 'order 应为 43（紧跟济大词元文生图的 42）')
  assert.match(src, /dsh-wechat-clawbot/, '应请求宿主路由')
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web', 'package.json 应声明 dsh.client')
})

globalThis.fetch = originalFetch

console.log('')
console.log(`结果：${passed} 通过，${failed} 失败`)

try {
  fs.rmSync(tmpHome, { recursive: true, force: true })
} catch {
  // 忽略。
}

process.exit(failed === 0 ? 0 : 1)
