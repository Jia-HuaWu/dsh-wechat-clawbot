/**
 * 一次性维护脚本：把任意本地文件推到微信（走 iLink 的文件消息）。
 * 用插件自己的 ILinkClient（token/context_token 从 state.json 读），
 * 上传流程与 sendImage 一致：AES-128-ECB 加密 → getuploadurl → POST CDN
 * → 用响应头的 x-encrypted-param 发 file_item 消息。
 *
 * 用法: node scripts/_push-file.mjs <文件路径> [发送名] [收件人userId]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  ILinkClient,
  MessageItemType,
  MessageType,
  MessageState,
  UploadMediaType,
  CDN_BASE_URL,
  encryptAesEcb,
} from '../lib/ilink.mjs'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const state = JSON.parse(
  fs.readFileSync(path.join(dshHome, 'dsh-wechat-clawbot', 'state.json'), 'utf8'),
)

const filePath = process.argv[2]
const sendName = process.argv[3] || path.basename(filePath)
const to = process.argv[4]
  || Object.entries(state.contextTokens ?? {}).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))[0]?.[0]
  || state.userId
if (!filePath || !fs.existsSync(filePath) || !to || !state.token) {
  console.error('用法: node scripts/_push-file.mjs <文件路径> [发送名] [收件人]（或检查 state.json）')
  process.exit(1)
}

const data = fs.readFileSync(filePath)
console.log(`文件: ${filePath} (${data.length} 字节) -> 发送名「${sendName}」`)
console.log(`收件人: ${to}`)

const client = new ILinkClient({
  baseUrl: state.baseUrl || 'https://ilinkai.weixin.qq.com',
  token: state.token,
  log: (level, msg) => console.log(`[${level}] ${msg}`),
})

// 上传（和 uploadImage 同构，media_type 换成 FILE=3）
const aesKey = crypto.randomBytes(16)
const filekey = crypto.randomBytes(16).toString('hex')
const rawfilemd5 = crypto.createHash('md5').update(data).digest('hex')
const ciphertext = encryptAesEcb(data, aesKey)

const uploadResp = await client.getUploadUrl({
  filekey,
  mediaType: UploadMediaType.FILE,
  toUserId: to,
  rawsize: data.length,
  rawfilemd5,
  filesize: ciphertext.length,
  aeskey: aesKey.toString('hex'),
  noNeedThumb: true,
})
const fullUrl = typeof uploadResp?.upload_full_url === 'string' ? uploadResp.upload_full_url.trim() : ''
const uploadParam = uploadResp?.upload_param
let cdnUrl
if (fullUrl) cdnUrl = fullUrl
else if (uploadParam) {
  cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
} else {
  console.error('getUploadUrl 没返回上传地址:', JSON.stringify(uploadResp).slice(0, 300))
  process.exit(2)
}

const res = await fetch(cdnUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: new Uint8Array(ciphertext),
})
if (res.status !== 200) {
  console.error(`CDN 上传失败 ${res.status}:`, res.headers.get('x-error-message') ?? (await res.text()).slice(0, 200))
  process.exit(2)
}
const downloadParam = res.headers.get('x-encrypted-param')
if (!downloadParam) {
  console.error('CDN 响应缺少 x-encrypted-param 头')
  process.exit(2)
}

// 发文件消息（字段名按入站镜像推断：file_name / len / media）
const ctxRec = state.contextTokens?.[to]
const contextToken = ctxRec && Date.now() - (ctxRec.at ?? 0) < 24 * 3600 * 1000 ? ctxRec.token : undefined
const resp = await client.sendMessage({
  from_user_id: '',
  to_user_id: to,
  client_id: `dsh-clawbot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  message_type: MessageType.BOT,
  message_state: MessageState.FINISH,
  context_token: contextToken || undefined,
  item_list: [{
    type: MessageItemType.FILE,
    file_item: {
      file_name: sendName,
      len: String(data.length),
      media: {
        encrypt_query_param: downloadParam,
        // 与图片一致：aes_key 是 base64(hex字符串)
        aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
        encrypt_type: 1,
      },
    },
  }],
})
console.log('发送响应:', JSON.stringify(resp, null, 2).slice(0, 400))
if (!resp?.message_id) {
  console.error('发送可能失败（无 message_id）')
  process.exit(3)
}
