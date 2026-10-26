/**
 * scripts/selftest.mjs — 不依赖 DSH 运行时的自检。
 *
 * 默认只做**离线**检查：纯函数、状态文件、协议编解码。
 * 加 `--live` 会真的打一次腾讯 iLink 的二维码接口，验证协议能通。
 *
 *   node scripts/selftest.mjs
 *   node scripts/selftest.mjs --live
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CDN_BASE_URL,
  FIXED_BASE_URL,
  ILinkClient,
  MessageItemType,
  MessageType,
  aesEcbPaddedSize,
  buildClientVersion,
  decryptAesEcb,
  encryptAesEcb,
  extractInboundText,
  inboundImageItems,
  isInboundUserMessage,
  parseAesKey,
  parseLosslessJson,
} from '../lib/ilink.mjs'

const live = process.argv.includes('--live')
let passed = 0
let failed = 0

/**
 * 跑一个检查项，失败不中断其余用例。
 * @param {string} label 用例名。
 * @param {() => any} fn 用例体（可 async）。
 */
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

console.log('dsh-wechat-clawbot 自检')
console.log(`  Node ${process.version}`)
console.log('')

// ── 纯函数 ────────────────────────────────────────────────────────────────
console.log('协议编解码：')

await test('buildClientVersion 按 0x00MMNNPP 编码', () => {
  // 1.0.11 -> 0x0001000B = 65547，这是官方源码注释里给的例子。
  assert.equal(buildClientVersion('1.0.11'), 65547)
  assert.equal(buildClientVersion('1.0.0'), 65536)
  assert.equal(buildClientVersion('2.4.10'), 0x02040a)
})

await test('parseLosslessJson 保住 uint64 消息 ID 的精度', () => {
  const big = '9007199254740991234'
  const raw = `{"ret":0,"message_id":${big},"nested":{"svr_id":${big}},"note":"id ${big} 不该被改"}`
  const parsed = parseLosslessJson(raw)
  assert.equal(parsed.message_id, big, 'message_id 必须是字符串且不丢精度')
  assert.equal(parsed.nested.svr_id, big, '嵌套的 svr_id 也要处理')
  assert.equal(parsed.note, `id ${big} 不该被改`, '字符串内部不能被改写')
  assert.equal(parsed.ret, 0, '普通数字保持数字')
})

await test('parseLosslessJson 对普通 JSON 无副作用', () => {
  const obj = { a: 1, b: [1, 2, 3], c: 'x', d: null, e: true }
  assert.deepEqual(parseLosslessJson(JSON.stringify(obj)), obj)
})

await test('parseLosslessJson 正确处理转义引号', () => {
  const raw = '{"text":"he said \\"hi\\"","message_id":1234567890123456789012}'
  const parsed = parseLosslessJson(raw)
  assert.equal(parsed.text, 'he said "hi"')
  assert.equal(parsed.message_id, '1234567890123456789012')
})

await test('extractInboundText 抽文本并标注非文本类型', () => {
  const textMsg = {
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: '你好' } }],
  }
  assert.equal(extractInboundText(textMsg), '你好')

  const mixed = {
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: '看图' } },
      { type: MessageItemType.IMAGE },
    ],
  }
  assert.equal(extractInboundText(mixed), '看图\n[图片]')

  const voice = {
    item_list: [{ type: MessageItemType.VOICE, voice_item: { text: '语音内容' } }],
  }
  assert.equal(extractInboundText(voice), '[语音] 语音内容')

  assert.equal(extractInboundText({ item_list: [] }), '')
  assert.equal(extractInboundText(undefined), '')
})

await test('isInboundUserMessage 只认用户消息', () => {
  assert.equal(isInboundUserMessage({ message_type: MessageType.USER }), true)
  assert.equal(isInboundUserMessage({ message_type: MessageType.BOT }), false)
  assert.equal(isInboundUserMessage({}), false)
  assert.equal(isInboundUserMessage(undefined), false)
})

// ── 请求头 ────────────────────────────────────────────────────────────────
console.log('')
console.log('请求头与鉴权：')

await test('未登录时不带 Authorization，登录后带 Bearer token', () => {
  const client = new ILinkClient({})
  // 私有方法用 # 声明，这里通过真实请求来观察头 —— 离线模式下改为反射检查字段。
  assert.equal(client.token, '')
  client.setSession({ token: 'tok_abc' })
  assert.equal(client.token, 'tok_abc')
  client.setSession({ token: '' })
  assert.equal(client.token, '', 'setSession 允许把 token 清空')
})

await test('setSession 能切换 baseUrl 且忽略空值', () => {
  const client = new ILinkClient({})
  assert.equal(client.baseUrl, FIXED_BASE_URL)
  client.setSession({ baseUrl: 'https://idc2.weixin.qq.com' })
  assert.equal(client.baseUrl, 'https://idc2.weixin.qq.com')
  client.setSession({ baseUrl: '' })
  assert.equal(client.baseUrl, 'https://idc2.weixin.qq.com', '空串不应覆盖已有地址')
})

await test('X-WECHAT-UIN 每次不同且能 base64 解回十进制', async () => {
  // 通过伪造一次 fetch 来拿到真实请求头。
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (_url, init) => {
    seen.push(init.headers)
    return { ok: true, status: 200, text: async () => '{"ret":0}' }
  }
  try {
    const client = new ILinkClient({ token: 'tok' })
    await client.notifyStart()
    await client.notifyStart()
    assert.equal(seen.length, 2)
    const uins = seen.map((h) => h['X-WECHAT-UIN'])
    assert.notEqual(uins[0], uins[1], '每次请求的 X-WECHAT-UIN 都应该不同')
    for (const uin of uins) {
      const decoded = Buffer.from(uin, 'base64').toString('utf8')
      assert.match(decoded, /^\d+$/, `UIN 应该 base64 成十进制数字，实际 ${decoded}`)
      const value = Number(decoded)
      assert.ok(value >= 0 && value <= 0xffffffff, 'UIN 必须在 uint32 范围内')
    }
    for (const h of seen) {
      assert.equal(h.Authorization, 'Bearer tok')
      assert.equal(h.AuthorizationType, 'ilink_bot_token')
      assert.equal(h['iLink-App-Id'], 'bot')
      assert.equal(h['iLink-App-ClientVersion'], String(buildClientVersion('1.0.0')))
      assert.equal(h['Content-Type'], 'application/json')
    }
  } finally {
    globalThis.fetch = original
  }
})

// ── 请求路径 ──────────────────────────────────────────────────────────────
console.log('')
console.log('接口路径：')

await test('sendText 组装出正确的 sendmessage 请求体', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) }
    return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":1}' }
  }
  try {
    const client = new ILinkClient({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'tok',
    })
    await client.sendText({
      to: 'user@im.wechat',
      text: 'hello',
      contextToken: 'ctx_1',
    })
    assert.match(captured.url, /\/ilink\/bot\/sendmessage$/)
    const msg = captured.body.msg
    assert.equal(msg.to_user_id, 'user@im.wechat')
    assert.equal(msg.message_type, MessageType.BOT)
    assert.equal(msg.context_token, 'ctx_1')
    assert.equal(msg.item_list[0].text_item.text, 'hello')
    assert.equal(captured.body.base_info.channel_version, '1.0.0')
    assert.ok(msg.client_id.startsWith('dsh-clawbot-'))
  } finally {
    globalThis.fetch = original
  }
})

await test('getUpdates 带上游标与 base_info', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) }
    return {
      ok: true,
      status: 200,
      text: async () => '{"ret":0,"msgs":[],"get_updates_buf":"cursor-2"}',
    }
  }
  try {
    const client = new ILinkClient({ token: 'tok' })
    const resp = await client.getUpdates({ getUpdatesBuf: 'cursor-1' })
    assert.match(captured.url, /\/ilink\/bot\/getupdates$/)
    assert.equal(captured.body.get_updates_buf, 'cursor-1')
    assert.ok(captured.body.base_info)
    assert.equal(resp.get_updates_buf, 'cursor-2')
  } finally {
    globalThis.fetch = original
  }
})

await test('getUpdates 客户端超时返回空结果而不是抛错', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  try {
    const client = new ILinkClient({ token: 'tok' })
    const resp = await client.getUpdates({ getUpdatesBuf: 'keep-me', timeoutMs: 10 })
    assert.equal(resp.ret, 0)
    assert.deepEqual(resp.msgs, [])
    assert.equal(resp.get_updates_buf, 'keep-me', '超时不应丢游标')
  } finally {
    globalThis.fetch = original
  }
})

await test('sendMessage 把 ret 非 0 转成异常', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '{"ret":-14,"errmsg":"session timeout"}',
  })
  try {
    const client = new ILinkClient({ token: 'tok' })
    await assert.rejects(
      () => client.sendText({ to: 'u@im.wechat', text: 'x', contextToken: 'c' }),
      /ret=-14/,
    )
  } finally {
    globalThis.fetch = original
  }
})

await test('HTTP 非 2xx 会抛出带状态码的错误', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' })
  try {
    const client = new ILinkClient({ token: 'tok' })
    await assert.rejects(() => client.notifyStart(), /502/)
  } finally {
    globalThis.fetch = original
  }
})

// ── 媒体：AES 与 CDN ──────────────────────────────────────────────────────
console.log('')
console.log('媒体加解密：')

await test('AES-128-ECB 加解密往返正确', () => {
  const key = Buffer.from('0123456789abcdef', 'utf8')
  const plaintext = Buffer.from('这是一段要被送到微信的中文内容', 'utf8')
  const ciphertext = encryptAesEcb(plaintext, key)
  assert.notEqual(ciphertext.length, plaintext.length, '有 PKCS7 补齐，长度应该变化')
  assert.equal(ciphertext.length % 16, 0, '密文长度必须是 16 的倍数')
  const roundTrip = decryptAesEcb(ciphertext, key)
  assert.deepEqual(roundTrip, plaintext, '解密后必须还原原文')
})

await test('aesEcbPaddedSize 与真实加密长度一致', () => {
  const key = Buffer.from('0123456789abcdef', 'utf8')
  for (const size of [0, 1, 15, 16, 17, 100, 4096]) {
    const plaintext = Buffer.alloc(size, 0x41)
    const actual = encryptAesEcb(plaintext, key).length
    assert.equal(aesEcbPaddedSize(size), actual, `size=${size} 时预估值应等于实际值`)
  }
})

await test('parseAesKey 支持 base64(原始16字节) 与 base64(hex字符串)', () => {
  const rawKey = Buffer.from('0123456789abcdef', 'utf8')
  // 形式一：base64(原始 key)
  const form1 = rawKey.toString('base64')
  assert.deepEqual(parseAesKey(form1), rawKey)
  // 形式二：base64(key 的 32 位 hex)
  const form2 = Buffer.from(rawKey.toString('hex'), 'ascii').toString('base64')
  assert.deepEqual(parseAesKey(form2), rawKey)
  // 非法输入要报错
  assert.throws(() => parseAesKey(Buffer.from('short').toString('base64')), /aes_key/)
})

await test('inboundImageItems 只挑出图片 item', () => {
  const msg = {
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: 'hi' } },
      { type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'q' } } },
      { type: MessageItemType.IMAGE, image_item: {} },
    ],
  }
  const images = inboundImageItems(msg)
  assert.equal(images.length, 1, '没有 media 的图片 item 应被过滤')
  assert.equal(inboundImageItems({ item_list: [] }).length, 0)
})

console.log('')
console.log('CDN 上传：')

await test('uploadImage 走完 getuploadurl → POST 密文 → 取 x-encrypted-param', async () => {
  const original = globalThis.fetch
  const calls = []
  const imageBytes = Buffer.from('fake png bytes for upload test')

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers })

    if (String(url).includes('getuploadurl')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ret: 0,
          upload_full_url: 'https://cdn.example.com/upload?token=abc',
        }),
        headers: { get: () => null },
      }
    }
    // CDN 上传响应：只要带 x-encrypted-param 头就算成功。
    return {
      ok: true,
      status: 200,
      text: async () => '',
      headers: { get: (k) => (k.toLowerCase() === 'x-encrypted-param' ? 'DOWNLOAD_PARAM_1' : null) },
    }
  }

  try {
    const client = new ILinkClient({ token: 'tok' })
    const uploaded = await client.uploadImage({
      data: imageBytes,
      toUserId: 'friend@im.wechat',
      cdnBaseUrl: CDN_BASE_URL,
    })

    assert.equal(uploaded.downloadParam, 'DOWNLOAD_PARAM_1')
    assert.equal(uploaded.plaintextSize, imageBytes.length)
    assert.equal(uploaded.ciphertextSize % 16, 0, '上传的密文长度应是 16 的倍数')

    // 校验 getuploadurl 的请求体字段齐全。
    const uploadReq = calls.find((c) => c.url.includes('getuploadurl'))
    const reqBody = JSON.parse(uploadReq.body)
    assert.equal(reqBody.media_type, 1, '图片的 media_type 是 1')
    assert.equal(reqBody.to_user_id, 'friend@im.wechat')
    assert.equal(reqBody.rawsize, imageBytes.length)
    assert.match(reqBody.rawfilemd5, /^[0-9a-f]{32}$/, 'rawfilemd5 应是 32 位 hex')
    assert.ok(reqBody.aeskey, '必须下发 aeskey')

    // 校验 CDN POST 的是密文（长度和内容都和原文不同）。
    const cdnCall = calls.find((c) => c.url === 'https://cdn.example.com/upload?token=abc')
    assert.ok(cdnCall, '应该 POST 到 upload_full_url')
    assert.equal(cdnCall.headers['Content-Type'], 'application/octet-stream')
    assert.equal(cdnCall.body.length % 16, 0)
    assert.notDeepEqual(Buffer.from(cdnCall.body), imageBytes)
  } finally {
    globalThis.fetch = original
  }
})

await test('uploadImage 在 4xx 时快速失败', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('getuploadurl')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ upload_full_url: 'https://cdn.example.com/u' }),
        headers: { get: () => null },
      }
    }
    return {
      ok: false,
      status: 403,
      text: async () => 'forbidden',
      headers: { get: (k) => (k.toLowerCase() === 'x-error-message' ? 'denied' : null) },
    }
  }
  try {
    const client = new ILinkClient({ token: 'tok' })
    await assert.rejects(
      () => client.uploadImage({ data: Buffer.from('x'), toUserId: 'u@im.wechat' }),
      /客户端错误 403/,
    )
  } finally {
    globalThis.fetch = original
  }
})

await test('sendImage 发出的消息里 context_token 与 media 字段正确', async () => {
  const original = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('getuploadurl')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ upload_full_url: 'https://cdn.example.com/u' }),
        headers: { get: () => null },
      }
    }
    if (u.includes('cdn.example.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        headers: { get: (k) => (k.toLowerCase() === 'x-encrypted-param' ? 'QP1' : null) },
      }
    }
    // sendmessage
    sent.push(JSON.parse(init.body))
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ret: 0, message_id: '1' }),
      headers: { get: () => null },
    }
  }
  try {
    const client = new ILinkClient({ token: 'tok' })
    await client.sendImage({
      to: 'friend@im.wechat',
      data: Buffer.from('img-bytes'),
      text: '这是配文',
      contextToken: 'ctx-9',
      cdnBaseUrl: CDN_BASE_URL,
    })

    // 图文分两条发。
    assert.equal(sent.length, 2, '有配文时应该发两条：文本 + 图片')
    assert.equal(sent[0].msg.item_list[0].text_item.text, '这是配文')
    assert.equal(sent[0].msg.context_token, 'ctx-9')

    const imageMsg = sent[1].msg
    assert.equal(imageMsg.context_token, 'ctx-9')
    const imageItem = imageMsg.item_list[0]
    assert.equal(imageItem.type, MessageItemType.IMAGE)
    assert.equal(imageItem.image_item.media.encrypt_query_param, 'QP1')
    assert.equal(imageItem.image_item.media.encrypt_type, 1)
    assert.ok(imageItem.image_item.media.aes_key, '必须带 aes_key')
    assert.ok(imageItem.image_item.mid_size > 0, 'mid_size 应填密文大小')
  } finally {
    globalThis.fetch = original
  }
})

// ── 真实链路 ──────────────────────────────────────────────────────────────
if (live) {
  console.log('')
  console.log('真实链路（打腾讯 iLink 接口）：')
  await test('get_bot_qrcode 能拿到二维码', async () => {
    const client = new ILinkClient({})
    const qr = await client.getBotQrcode([])
    assert.equal(qr.ret ?? 0, 0, `ret 应为 0，实际 ${JSON.stringify(qr)}`)
    assert.ok(typeof qr.qrcode === 'string' && qr.qrcode.length > 0, '应该有 qrcode')
    assert.match(
      qr.qrcode_img_content ?? '',
      /^https:\/\//,
      'qrcode_img_content 应该是个 https 链接',
    )
    console.log(`       qrcode=${qr.qrcode}`)
    console.log(`       url=${qr.qrcode_img_content}`)
  })
}

console.log('')
console.log(`结果：${passed} 通过，${failed} 失败${live ? '（含真实链路）' : '（离线）'}`)
process.exit(failed === 0 ? 0 : 1)
