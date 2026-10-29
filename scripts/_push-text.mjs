/**
 * 一次性维护脚本：绕过 LLM 直接给微信发文本。
 * 用插件自己的 ILinkClient（token/context_token 从 state.json 读），
 * 所以就算学校官网没登录、LLM 调不动，也能发出"该登录了"的提醒。
 *
 * 用法: node scripts/_push-text.mjs <文本> [收件人userId]
 *       不传收件人就用 state.json 里最近联系过的那个
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ILinkClient } from '../lib/ilink.mjs'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const state = JSON.parse(
  fs.readFileSync(path.join(dshHome, 'dsh-wechat-clawbot', 'state.json'), 'utf8'),
)

const text = process.argv[2]
if (!text) {
  console.error('用法: node scripts/_push-text.mjs <文本> [收件人userId]')
  process.exit(1)
}

// 收件人：参数 > state 里最近联系过的联系人
const to =
  process.argv[3] ||
  Object.entries(state.contextTokens ?? {})
    .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))[0]?.[0] ||
  state.userId
if (!to) {
  console.error('拿不到收件人 userId，请显式传入')
  process.exit(1)
}

// context_token：state 里最近回带的那份（24h 内有效，过旧就不带，让服务端按 bot 会话兜底）
const ctxRec = state.contextTokens?.[to]
const ctxAge = ctxRec ? Date.now() - (ctxRec.at ?? 0) : Infinity
const contextToken = ctxRec && ctxAge < 24 * 3600 * 1000 ? ctxRec.token : undefined

console.log(`收件人: ${to}`)
console.log(`context_token: ${contextToken ? `${String(contextToken).slice(0, 8)}… (${Math.round(ctxAge / 60000)} 分钟前)` : '(无，裸发)'}`)

const client = new ILinkClient({
  baseUrl: state.baseUrl || 'https://ilinkai.weixin.qq.com',
  token: state.token,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
})

const resp = await client.sendText({ to, text, contextToken })
console.log('发送响应:', JSON.stringify(resp, null, 2).slice(0, 500))
// 成功响应形如 { message_id: "..." }；失败时才有 ret/errcode 字段
if (resp && !resp.message_id) {
  console.error('发送可能失败（见上方响应）')
  process.exit(2)
}
