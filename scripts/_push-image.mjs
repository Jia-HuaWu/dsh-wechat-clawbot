/**
 * 一次性维护脚本：把卡在兜底会话里的图片补推到微信。
 * 用插件自己的 ILinkClient（token 从 state.json 读），走和插件一致的发送路径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ILinkClient } from '../lib/ilink.mjs'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const state = JSON.parse(
  fs.readFileSync(path.join(dshHome, 'dsh-wechat-clawbot', 'state.json'), 'utf8'),
)

const imgPath = process.argv[2]
const caption = process.argv[3] ?? ''
if (!imgPath) {
  console.error('用法: node scripts/_push-image.mjs <图片路径> [说明文字]')
  process.exit(1)
}

const to = state.userId
if (!to || !state.token) {
  console.error('state.json 里没有 userId 或 token，无法发送')
  process.exit(1)
}

const client = new ILinkClient({
  baseUrl: state.baseUrl || 'https://ilinkai.weixin.qq.com',
  token: state.token,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
})

const data = fs.readFileSync(imgPath)
console.log(`图片: ${imgPath} (${data.length} 字节)`)
console.log(`收件人: ${to}`)

const resp = await client.sendImage({ to, data, text: caption })
console.log('发送响应:', JSON.stringify(resp, null, 2).slice(0, 500))
