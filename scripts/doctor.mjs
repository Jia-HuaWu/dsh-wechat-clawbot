/**
 * scripts/doctor.mjs — 微信 ClawBot 通道体检（只读，不改任何东西）。
 *
 * 出问题时先跑这个，它会一次性告诉你：
 *   · 插件是否登录、token 是否还有效
 *   · 绑定指向哪个会话、那个会话是否还能打开
 *   · 有没有悬着的待领取绑定
 *   · 要不要重新扫码
 *
 * 用法：
 *   node scripts/doctor.mjs [--port 19387]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const argOf = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : d
}
const port = argOf('--port', '19387')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const problems = []
const notes = []

console.log('微信 ClawBot 体检')
console.log(`  DSH_HOME = ${dshHome}`)
console.log(`  插件端口 = ${port}`)
console.log('')

// ── 1. 插件状态 ──────────────────────────────────────────────────────────
let status = null
try {
  const res = await fetch(`http://127.0.0.1:${port}/dsh-wechat-clawbot/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
    body: '{}',
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  status = await res.json()
  console.log('【插件状态】')
  console.log(`  loggedIn    : ${status.loggedIn}`)
  console.log(`  monitoring  : ${status.monitoring}`)
  console.log(`  accountId   : ${status.accountId || '(无)'}`)
  console.log(`  needsRelogin: ${status.needsRelogin}`)
  console.log(`  lastError   : ${status.lastError || '(无)'}`)
  console.log(`  inbound/out : ${status.stats.inbound} / ${status.stats.outbound}`)
  if (status.needsRelogin) {
    problems.push('token 已失效（needsRelogin=true）：需要重新扫码登录')
  }
  if (!status.loggedIn) {
    problems.push('未登录：需要扫码')
  }
  if (status.loggedIn && !status.monitoring) {
    problems.push('已登录但没有在监听：消息不会被收取')
  }
} catch (error) {
  problems.push(`连不上插件路由（${error?.message ?? error}）：DSH 没启动，或插件没装好`)
  console.log('【插件状态】无法读取')
}

// ── 2. token 有效性（直接问服务端）────────────────────────────────────────
const statePath = path.join(dshHome, 'dsh-wechat-clawbot', 'state.json')
let state = null
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
} catch {
  problems.push(`读不到插件状态文件：${statePath}`)
}

if (state?.token) {
  try {
    const uinBuf = Buffer.alloc(4)
    globalThis.crypto.getRandomValues(uinBuf)
    const uin = Buffer.from(String(uinBuf.readUInt32BE(0)), 'utf8').toString('base64')
    const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/getupdates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': uin,
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String(1 << 16),
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({
        get_updates_buf: state.getUpdatesBuf || '',
        base_info: { channel_version: 'doctor/1.0', bot_agent: 'doctor/1.0' },
      }),
      signal: AbortSignal.timeout(40000),
    })
    const body = await res.json().catch(() => ({}))
    console.log('')
    console.log('【token 有效性】')
    if (body.errcode === 0 || body.ret === 0) {
      console.log('  ✅ token 有效')
      if (Array.isArray(body.msgs) && body.msgs.length > 0) {
        notes.push(`服务端还有 ${body.msgs.length} 条消息待取 —— 插件可能在空转，重启试试`)
      }
    } else {
      console.log(`  ❌ errcode=${body.errcode} ${body.errmsg ?? ''}`)
      if (body.errcode === -14) {
        problems.push('token 已被服务端判定失效（-14 session timeout）：必须重新扫码')
      } else {
        problems.push(`服务端返回错误 ${body.errcode}：${body.errmsg ?? ''}`)
      }
    }
  } catch (error) {
    console.log('')
    console.log('【token 有效性】')
    console.log(`  探测失败：${error?.message ?? error}`)
    notes.push('token 探测失败可能是网络问题，不代表 token 失效')
  }
} else {
  console.log('')
  console.log('【token 有效性】')
  console.log('  没有 token（未登录）')
}

// ── 3. 绑定与会话健康 ────────────────────────────────────────────────────
console.log('')
console.log('【绑定】')

/**
 * 在 sessions 目录里找某个会话的日志。
 * @param {string} sessionId
 * @returns {string|null}
 */
function findSessionLog(sessionId) {
  const root = path.join(dshHome, 'sessions')
  if (!fs.existsSync(root)) return null
  for (const projectDir of fs.readdirSync(root)) {
    const p = path.join(root, projectDir, sessionId, 'session.v4.jsonl.zstd')
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 检查会话日志是否可读（逐帧解压 + 检查 user/message 的 id/role）。
 * @param {string} file
 * @returns {{ok: boolean, events: number, badMessages: number, error?: string}}
 */
function checkSessionFile(file) {
  try {
    const raw = fs.readFileSync(file)
    const MAGIC = 0xfd2fb528
    const starts = []
    for (let o = 0; o + 4 <= raw.length; o += 1) {
      if (raw.readUInt32LE(o) === MAGIC) starts.push(o)
    }
    const texts = []
    for (let k = 0; k < starts.length; k += 1) {
      const s = starts[k]
      const e = k + 1 < starts.length ? starts[k + 1] : raw.length
      texts.push(zlib.zstdDecompressSync(raw.subarray(s, e)).toString('utf8'))
    }
    const events = []
    for (const line of texts.join('').split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // 跳过
      }
    }
    const bad = events.filter(
      (e) => e.type === 'user/message' && (!e.data?.id || !e.data?.role),
    ).length
    return { ok: true, events: events.length, badMessages: bad }
  } catch (error) {
    return { ok: false, events: 0, badMessages: 0, error: String(error?.message ?? error) }
  }
}

const bindings = state?.bindings ?? {}
if (Object.keys(bindings).length === 0) {
  console.log('  （没有任何绑定）')
  problems.push('没有绑定：在对话里说「把这个对话绑定到微信」')
} else {
  for (const [userId, row] of Object.entries(bindings)) {
    const log = findSessionLog(row.sessionId)
    if (!log) {
      console.log(`  ${userId}`)
      console.log(`    -> ${row.sessionId}`)
      console.log('    ⚠️ 找不到这个会话的日志文件')
      problems.push(`绑定的会话 ${row.sessionId} 不存在：建议重新绑定`)
      continue
    }
    const c = checkSessionFile(log)
    console.log(`  ${userId}`)
    console.log(`    -> ${row.sessionId}`)
    console.log(`    日志: ${c.ok ? `${c.events} 条事件` : `读取失败 ${c.error}`}`)
    if (c.ok && c.badMessages > 0) {
      console.log(`    ⚠️ ${c.badMessages} 条消息缺 id/role（会话可能被判 corrupt）`)
      problems.push(`会话 ${row.sessionId} 有 ${c.badMessages} 条坏消息`)
    }
    // 在 workspace 里吗
    const wsFile = path.join(dshHome, 'storages', 'workspace.json')
    if (fs.existsSync(wsFile)) {
      try {
        const ws = JSON.parse(fs.readFileSync(wsFile, 'utf8'))
        const inAny = Object.values(ws.tables?.workspaces ?? {}).some((w) =>
          (w.sessionIds ?? []).includes(row.sessionId))
        if (!inAny) {
          console.log('    ⚠️ 这个会话不在任何 workspace 里（会显示为「未分组」）')
          notes.push('会话未登记到 workspace：发一条微信消息，插件会自动挂回去')
        }
      } catch {
        // 忽略
      }
    }
  }
}

// ── 4. 待领取绑定 ────────────────────────────────────────────────────────
const pending = Object.entries(state?.pendingBinds ?? {})
console.log('')
console.log('【待领取绑定】')
if (pending.length === 0) {
  console.log('  （无）')
} else {
  const TTL = 12 * 60 * 60 * 1000
  const now = Date.now()
  const sorted = pending.sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0))
  for (const [code, row] of sorted) {
    const ageMin = Math.round((now - (row.createdAt ?? 0)) / 60000)
    const expired = now - (row.createdAt ?? 0) > TTL
    console.log(`  ${code} -> ${row.sessionId}  ${ageMin} 分钟前${expired ? ' 【已过期】' : ''}`)
  }
  notes.push('有悬着的待领取绑定：新版会在扫码确认时直接绑定，这些记录不再需要')
}

// ── 结论 ─────────────────────────────────────────────────────────────────
console.log('')
console.log('【结论】')
if (problems.length === 0 && notes.length === 0) {
  console.log('  ✅ 没发现问题。')
} else {
  if (problems.length > 0) {
    console.log('  发现的问题：')
    for (const p of problems) console.log(`    ❌ ${p}`)
  }
  if (notes.length > 0) {
    console.log('  提示：')
    for (const n of notes) console.log(`    · ${n}`)
  }
}

console.log('')
console.log('修复建议：')
if (problems.some((p) => p.includes('失效') || p.includes('未登录') || p.includes('重新扫码'))) {
  console.log('  1. 在对话里说「把这个对话绑定到微信」重新扫码')
  console.log('     （二维码约 2.5 分钟过期，扫的时候要快）')
  console.log('  2. 扫完不用发消息 —— 新版本扫码确认就直接绑定')
} else {
  console.log('  通道看起来正常。如果微信发消息没反应，重启 DSH 再试。')
}

process.exit(problems.length === 0 ? 0 : 1)
