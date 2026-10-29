/**
 * scripts/_probe-send.mjs — 诊断 sendMessage ret=-2 的一次性脚本。
 * 依次尝试：notifyStart → 无 context_token 发送 → 存储的 context_token 发送 → getConfig。
 * 探测成功会真的发到微信（文本带 [probe] 前缀）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ILinkClient } from '../lib/ilink.mjs'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const state = JSON.parse(
  fs.readFileSync(path.join(dshHome, 'dsh-wechat-clawbot', 'state.json'), 'utf8'),
)

const to = process.argv[2] || state.userId
const client = new ILinkClient({
  baseUrl: state.baseUrl,
  token: state.token,
  log: (l, m) => console.log(`[${l}] ${m}`),
})

const trySend = async (label, contextToken) => {
  try {
    const resp = await client.sendText({ to, text: `[probe] ${label}`, contextToken })
    console.log(`${label}: OK ${JSON.stringify(resp).slice(0, 200)}`)
    return true
  } catch (e) {
    console.log(`${label}: FAIL ${e.message}`)
    return false
  }
}

// 0. 重新上线通知（插件只在启动时调过一次）
try {
  const r = await client.notifyStart()
  console.log(`notifyStart: OK ${JSON.stringify(r).slice(0, 200)}`)
} catch (e) {
  console.log(`notifyStart: FAIL ${e.message}`)
}

// A. 不带 context_token（服务端按 bot 会话兜底）
await trySend('no-ctx', undefined)

// B. 带 state 里存储的 context_token
const rec = state.contextTokens?.[to]
const ageMin = rec ? Math.round((Date.now() - (rec.at ?? 0)) / 60000) : -1
await trySend(`stored-ctx(${ageMin}min-old)`, rec?.token)

// C. getConfig 探测（不产生消息）
try {
  const cfg = await client.getConfig(to, rec?.token)
  console.log(`getConfig: OK ${JSON.stringify(cfg).slice(0, 300)}`)
} catch (e) {
  console.log(`getConfig: FAIL ${e.message}`)
}
