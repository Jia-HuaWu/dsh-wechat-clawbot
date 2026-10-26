/**
 * scripts/_rebind.mjs — 把微信绑定从一个会话改到另一个会话（一次性维护脚本）。
 *
 * 背景：插件早期有个 bug——微信「已有绑定」时直接复用旧绑定，导致用户重新
 * 扫码想换对话时新码永远不生效，消息一直进旧会话。
 *
 * 这个脚本直接改 state.json：把指定微信的绑定改到目标会话，并清掉陈旧的
 * 待绑定记录（它们只会造成混乱）。
 *
 * 用法：
 *   node scripts/_rebind.mjs --to <sessionId> [--user <wxUserId>] [--dry-run]
 *
 * 不加 --user 时会改所有已有绑定的联系人（通常就一个）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}

const dryRun = process.argv.includes('--dry-run')
const targetSession = argOf('--to', '')
const onlyUser = argOf('--user', '')

if (!targetSession) {
  console.error('用法: node scripts/_rebind.mjs --to <sessionId> [--user <wxUserId>] [--dry-run]')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const stateFile = path.join(dshHome, 'dsh-wechat-clawbot', 'state.json')

if (!fs.existsSync(stateFile)) {
  console.error(`找不到状态文件: ${stateFile}`)
  process.exit(1)
}

/** 在项目所有会话目录里确认目标会话确实存在。 */
function findSessionDir(sessionId) {
  const root = path.join(dshHome, 'sessions')
  if (!fs.existsSync(root)) return null
  for (const projectDir of fs.readdirSync(root)) {
    const candidate = path.join(root, projectDir, sessionId, 'session.v4.jsonl.zstd')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const logFile = findSessionDir(targetSession)
if (!logFile) {
  console.error(`目标会话不存在：${targetSession}`)
  console.error('（它必须已经有一个 session.v4.jsonl.zstd 日志文件）')
  process.exit(1)
}

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))

/**
 * 探测 DSH 是否正在运行（插件路由能不能应答）。
 *
 * 这很重要：运行中的实例把状态缓存在内存里，它任何一次 persist()
 * （比如 getUpdates 游标推进）都会整份覆盖 state.json。
 * 旧代码没有合并逻辑，所以我们这里的修改会在十几秒内被冲掉。
 *
 * @returns {Promise<{running: boolean, detail: string}>}
 */
async function probeRunningDsh() {
  const ports = [19387, 8787, 3080]
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-wechat-clawbot/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` },
        body: '{}',
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) {
        const body = await res.json()
        return { running: true, detail: `端口 ${port}（monitoring=${body.monitoring}）` }
      }
    } catch {
      // 这个端口没有
    }
  }
  return { running: false, detail: '' }
}

const probe = await probeRunningDsh()

console.log(`状态文件: ${stateFile}`)
console.log(`目标会话: ${targetSession}`)
console.log(`  日志: ${logFile}`)
console.log('')

const users = onlyUser ? [onlyUser] : Object.keys(state.bindings ?? {})
if (users.length === 0) {
  console.log('当前没有任何绑定，无法改绑。')
  process.exit(0)
}

let changed = 0
for (const userId of users) {
  const before = state.bindings?.[userId]?.sessionId ?? '(无)'
  if (!state.bindings) state.bindings = {}
  state.bindings[userId] = {
    sessionId: targetSession,
    boundAt: Date.now(),
    label: state.bindings[userId]?.label ?? '',
  }
  console.log(`微信 ${userId}`)
  console.log(`  ${before}  ->  ${targetSession}`)
  changed += 1
}

// 清掉所有陈旧的待绑定记录：它们指向各种旧会话，留着只会造成误绑。
const staleCount = Object.keys(state.pendingBinds ?? {}).length
state.pendingBinds = {}
console.log('')
console.log(`清理陈旧待绑定记录: ${staleCount} 条`)

if (dryRun) {
  console.log('')
  console.log('（--dry-run：未写入）')
  process.exit(0)
}

if (probe.running && !process.argv.includes('--force')) {
  console.log('')
  console.log('⚠️  检测到 DSH 正在运行：' + probe.detail)
  console.log('')
  console.log('   运行中的实例把绑定缓存在内存里，它下一次 persist()（例如 getUpdates')
  console.log('   游标推进）会整份覆盖 state.json，十几秒内就把这里的修改冲掉。')
  console.log('')
  console.log('   正确做法有两种：')
  console.log('')
  console.log('   A. 先退出 DSH，再跑一次这个脚本，然后重新打开 DSH。')
  console.log('   B. 用新版插件的 HTTP 接口（重启后可用），它直接改内存里的状态：')
  console.log(`        curl -X POST http://127.0.0.1:19387/dsh-wechat-clawbot/bind \\`)
  console.log(`             -H "Content-Type: application/json" \\`)
  console.log(`             -d '{"sessionId":"${targetSession}"}'`)
  console.log('')
  console.log('   确实要现在硬写（可能被覆盖）就加 --force。')
  process.exit(1)
}

fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })
console.log('')
console.log(`已写入。改绑 ${changed} 个联系人。`)
console.log('下一步：重启 DSH，让插件重新读取状态。')
