/**
 * scripts/verify-message-shape.mjs — 用**真实 dsh-session** 验证消息形状合法。
 *
 * 真实事故：`followup()` 只传 content + source，没传 id / role。
 * 内存里写得进去、消息也发得出去，但落盘后读回来会报
 *   session event at seq N lacks an identified message
 * 整个会话被判为 corrupt，历史加载失败。
 *
 * 这个脚本直接加载已安装的 dsh-session，用真实的 Session.append() 构造
 * user/message，验证：
 *   · 缺 id / role 的消息会被**读取期**校验拒绝（复现事故）
 *   · 插件实际构造的消息（带 id/role）能通过
 *
 * 用法：
 *   node scripts/verify-message-shape.mjs [--dsh-root <path>]
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}

const candidates = [
  argOf('--dsh-root', ''),
  process.env.DSH_NODE_MODULES ?? '',
  'D:/DeepseekHarness/resources/app.asar.unpacked/dsh/node_modules',
].filter(Boolean)

/**
 * 找到 dsh-session 的入口。
 * @returns {string|null}
 */
function findSession() {
  for (const root of candidates) {
    const p = path.join(root, '@deepseek-ai/dsh-session/lib/index.js')
    if (fs.existsSync(p)) return p
  }
  return null
}

const entry = findSession()
if (!entry) {
  console.log('跳过：没有找到 dsh-session 包。')
  console.log('  要跑这一项，先解包 asar：')
  console.log('    npx @electron/asar extract "D:/DeepseekHarness/resources/app.asar" ./app')
  console.log('    node scripts/verify-message-shape.mjs --dsh-root ./app/dsh/node_modules')
  process.exit(0)
}

const mod = await import(`file:///${entry.replace(/\\/g, '/')}`)
const { Session } = mod

console.log('消息形状验证（真实 dsh-session）')
console.log(`  依赖: ${entry}`)
console.log('')

let passed = 0
let failed = 0

/**
 * 跑一个检查。
 * @param {string} label
 * @param {() => void} fn
 */
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (e) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${e?.message ?? e}`)
  }
}

/**
 * 构造一个会话，追加一条 user/message，然后**重新读取并校验**。
 *
 * 关键：事故的报错发生在「读回已持久化的日志」时，所以这里要把事件
 * 序列化后再走一遍 Session.fromRestore / create(seed) 的校验路径。
 *
 * @param {object} message user/message 的 data。
 * @returns {{ok: boolean, error?: string}}
 */
function appendAndReload(message) {
  const session = Session.create('shape-check')
  try {
    session.append('user/message', message, { surfaceOp: 'append' })
  } catch (e) {
    return { ok: false, error: `append: ${e?.message ?? e}` }
  }
  // 模拟「落盘后重新加载」：把日志当作 seed 重建一次，走完整校验。
  try {
    const seed = session.log.map((e) => JSON.parse(JSON.stringify(e)))
    Session.create('shape-check-reload', seed)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `reload: ${e?.message ?? e}` }
  }
}

console.log('缺字段的消息（复现事故）：')

check('缺 id 的 user/message 在重新加载时会被拒绝', () => {
  const r = appendAndReload({
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  })
  if (r.ok) throw new Error('本应被拒绝（lacks an identified message），实际通过了')
  if (!/identified message/i.test(r.error)) {
    throw new Error(`错因不是预期的那种：${r.error}`)
  }
})

check('缺 role 的 user/message 在重新加载时会被拒绝', () => {
  const r = appendAndReload({
    id: randomUUID(),
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  })
  if (r.ok) throw new Error('本应被拒绝（must have role），实际通过了')
})

console.log('')
console.log('插件实际构造的消息（带 id/role）：')

check('带 id + role + source.kind=user 的消息能通过完整往返', () => {
  const r = appendAndReload({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '连接测试' }],
    source: { kind: 'user', via: 'dsh-wechat-clawbot', wechatUserId: 'u@im.wechat' },
  })
  if (!r.ok) throw new Error(`应通过，实际被拒：${r.error}`)
})

check('插件源码确实用了 createUserMessage（带 id/role）', () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'lib', 'index.js'),
    'utf8',
  )
  if (!/function createUserMessage/.test(src)) throw new Error('缺少 createUserMessage')
  if (!/id:\s*randomUUID\(\)/.test(src)) throw new Error('createUserMessage 没有生成 id')
  if (!/role:\s*'user'/.test(src)) throw new Error("createUserMessage 没有设置 role: 'user'")
  if (!/agent\.followup\(createUserMessage\(\{/.test(src)) {
    throw new Error('followup 没有用 createUserMessage 构造消息')
  }
})

console.log('')
console.log(`结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
