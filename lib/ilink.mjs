/**
 * ilink.mjs — 微信 ClawBot（iLink Bot）协议的最小实现。
 *
 * 这套协议是腾讯通过 OpenClaw 开放的**官方**个人微信 Bot 通道，域名
 * `ilinkai.weixin.qq.com`，纯 HTTP + JSON，不需要任何 SDK，也**不需要装
 * OpenClaw** —— 本文件就是从 `@tencent-weixin/openclaw-weixin` 里把协议
 * 抽出来独立实现的部分，只依赖 `node:*` 与全局 fetch。
 *
 * 协议五个要点：
 *   1. 鉴权：`POST ilink/bot/get_bot_qrcode?bot_type=3` 拿二维码 →
 *      长轮询 `get_qrcode_status` → `status=confirmed` 得到 `bot_token` 和 `baseurl`。
 *   2. 固定请求头：`AuthorizationType: ilink_bot_token`、`iLink-App-Id`、
 *      `iLink-App-ClientVersion`，以及每次随机生成的 `X-WECHAT-UIN`
 *      （uint32 十进制字符串再 base64，用于防重放）。
 *   3. 收消息：`ilink/bot/getupdates` 长轮询（服务端 hold 住约 35 秒）。
 *      返回的 `get_updates_buf` 是游标，必须持久化，否则重启会丢消息。
 *   4. 发消息：`ilink/bot/sendmessage`，**必须**回带入站消息里的
 *      `context_token`，否则消息对不上会话窗口。
 *   5. 媒体：CDN 上是 AES-128-ECB 加密的密文，key 随消息下发。
 *      收图：下载密文 → AES 解密 → 交给上层落盘。
 *      发图：本地图 → AES 加密 → getuploadurl → POST 密文到 CDN →
 *            拿到 x-encrypted-param → 作为 encrypt_query_param 塞进 sendmessage。
 *
 * `parseLosslessJson` 处理的是 uint64 消息 ID：/getupdates 返回的
 * message_id / svr_id 可能超出 JS 安全整数范围，直接 JSON.parse 会丢精度，
 * 这里先把这些字段的裸数字包成字符串再解析。
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

/** iLink 固定入口。登录二维码永远走这里，业务请求才走确认后拿到的 baseurl。 */
export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 媒体 CDN 入口。所有上传/下载都走它。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** 协议里硬编码的 bot_type，对应“ClawBot 通道”。 */
export const ILINK_BOT_TYPE = '3'

/** 本实现的自我标识，写进 `base_info.channel_version`。 */
export const CHANNEL_VERSION = '1.0.0'

/** 默认长轮询超时（服务端最长 hold 时间）。 */
export const DEFAULT_LONG_POLL_MS = 35_000

/** 普通业务请求超时。 */
const DEFAULT_API_MS = 15_000

/** 轻量请求超时（getconfig / sendtyping / notifystart）。 */
const DEFAULT_CONFIG_MS = 10_000

/** 这些字段在线上是 uint64，必须无损地当字符串解析。 */
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id'])

/** 消息方向。 */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 }

/** 消息项类型。 */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
}

/** 消息完成态。 */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 }

/** 上传媒体类型。 */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }

/** “正在输入”状态。 */
export const TypingStatus = { TYPING: 1, CANCEL: 2 }

/**
 * 把 JSON 文本里 uint64 字段的裸数字改写成字符串，避免 JSON.parse 丢精度。
 * 只处理对象属性位置，不会误伤字符串内部的文本。
 * @param {string} rawText 原始响应体。
 * @returns {any} 解析结果。
 */
export function parseLosslessJson(rawText) {
  let output = ''
  let i = 0
  while (i < rawText.length) {
    if (rawText[i] !== '"') {
      output += rawText[i++]
      continue
    }

    // 完整的字符串 token（含转义处理）。
    const start = i
    i++
    let escaped = false
    while (i < rawText.length) {
      const ch = rawText[i++]
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') break
    }
    const token = rawText.slice(start, i)
    output += token

    // 只有 "key": 后面才可能是要改写的数字。
    let cursor = i
    while (/\s/.test(rawText[cursor] ?? '')) cursor++
    if (rawText[cursor] !== ':') continue

    let key
    try {
      key = JSON.parse(token)
    } catch {
      continue
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue

    output += rawText.slice(i, cursor + 1)
    cursor++
    while (/\s/.test(rawText[cursor] ?? '')) output += rawText[cursor++]

    const numStart = cursor
    if (rawText[cursor] === '-') cursor++
    while (/\d/.test(rawText[cursor] ?? '')) cursor++
    if (cursor > numStart && !(cursor === numStart + 1 && rawText[numStart] === '-')) {
      output += `"${rawText.slice(numStart, cursor)}"`
      i = cursor
    } else {
      i = numStart
    }
  }
  return JSON.parse(output)
}

/**
 * 生成 `X-WECHAT-UIN`：随机 uint32 → 十进制字符串 → base64。
 * 官方实现每次请求都换一个，用于防重放。
 * @returns {string} base64 后的值。
 */
function randomWechatUin() {
  const buf = Buffer.alloc(4)
  globalThis.crypto.getRandomValues(buf)
  const uint32 = buf.readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

/**
 * 把 `1.2.3` 编码成 `0x00MMNNPP` 的 uint32，供 `iLink-App-ClientVersion` 使用。
 * @param {string} version 语义化版本。
 * @returns {number} 编码后的整数。
 */
export function buildClientVersion(version) {
  const parts = String(version).split('.').map((p) => parseInt(p, 10))
  const major = parts[0] || 0
  const minor = parts[1] || 0
  const patch = parts[2] || 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

const CLIENT_VERSION_INT = buildClientVersion(CHANNEL_VERSION)

/**
 * 一次可取消的带超时 fetch。内部超时与外部 abort 信号合并。
 * @param {string} url 绝对地址。
 * @param {object} init fetch 参数。
 * @param {object} opts timeoutMs / abortSignal / label。
 * @returns {Promise<{status: number, ok: boolean, text: () => Promise<string>}>}
 */
async function fetchWithTimeout(url, init, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 0
  const external = opts.abortSignal
  const controller = new AbortController()
  const cleanups = []

  if (timeoutMs > 0) {
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    cleanups.push(() => clearTimeout(timer))
  }
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason)
    } else {
      const onAbort = () => controller.abort(external.reason)
      external.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => external.removeEventListener('abort', onAbort))
    }
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    for (const fn of cleanups) fn()
  }
}

/**
 * iLink 客户端。一个实例对应一个已登录（或待登录）的微信 Bot 账号。
 */
export class ILinkClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl] 业务接口地址，登录前默认固定入口。
   * @param {string} [opts.token] bot_token，登录前为空。
   * @param {string} [opts.appId] `iLink-App-Id`，官方包里的 `ilink_appid` 是 `bot`。
   * @param {string} [opts.botAgent] 自我标识，写进 base_info.bot_agent。
   * @param {(level: string, msg: string) => void} [opts.log] 日志回调。
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || FIXED_BASE_URL
    this.token = opts.token || ''
    this.appId = opts.appId || 'bot'
    this.botAgent = opts.botAgent || `DSH-WechatClawBot/${CHANNEL_VERSION}`
    this.log = opts.log || (() => {})
  }

  /**
   * 更新登录态（扫码确认后调用）。
   * @param {{baseUrl?: string, token?: string}} session
   */
  setSession(session = {}) {
    if (session.baseUrl) this.baseUrl = session.baseUrl
    if (session.token !== undefined) this.token = session.token
  }

  /** 公共请求头（不含 token）。 */
  #commonHeaders() {
    return {
      'iLink-App-Id': this.appId,
      'iLink-App-ClientVersion': String(CLIENT_VERSION_INT),
    }
  }

  /** 带鉴权的请求头。 */
  #headers() {
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      ...this.#commonHeaders(),
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    return headers
  }

  /** 每个请求都带的 base_info。 */
  #baseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: this.botAgent }
  }

  /**
   * 把相对 endpoint 解析成绝对 URL；已是绝对地址则原样返回。
   * @param {string} endpoint
   * @param {string} [baseOverride]
   * @returns {string}
   */
  #url(endpoint, baseOverride) {
    if (/^https?:\/\//i.test(endpoint)) return endpoint
    const base = baseOverride || this.baseUrl
    const normalized = base.endsWith('/') ? base : `${base}/`
    return new URL(endpoint, normalized).toString()
  }

  /**
   * GET 请求（登录相关接口用它，鉴权头只有公共头）。
   * @param {string} endpoint 相对路径（可带 query）。
   * @param {object} opts timeoutMs / baseOverride。
   * @returns {Promise<string>} 原始响应体。
   */
  async #get(endpoint, opts = {}) {
    const url = this.#url(endpoint, opts.baseOverride)
    const res = await fetchWithTimeout(url, { method: 'GET', headers: this.#commonHeaders() }, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_API_MS,
      abortSignal: opts.abortSignal,
      label: opts.label,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${opts.label ?? 'GET'} ${res.status}: ${text}`)
    return text
  }

  /**
   * POST JSON 请求。
   * @param {string} endpoint 相对路径。
   * @param {object} body 请求体。
   * @param {object} [opts] timeoutMs / abortSignal / label。
   * @returns {Promise<string>} 原始响应体。
   */
  async #post(endpoint, body, opts = {}) {
    const url = this.#url(endpoint)
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
    }, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_API_MS,
      abortSignal: opts.abortSignal,
      label: opts.label,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${opts.label ?? 'POST'} ${res.status}: ${text}`)
    return text
  }

  /**
   * 获取登录二维码。
   * @param {string[]} [localTokenList] 本机已有 token，便于服务端识别“已绑定”。
   * @returns {Promise<{qrcode: string, qrcode_img_content: string, ret?: number}>}
   */
  async getBotQrcode(localTokenList = []) {
    const text = await this.#post(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`,
      { local_token_list: localTokenList },
      { timeoutMs: DEFAULT_API_MS, label: 'getBotQrcode' },
    )
    return JSON.parse(text)
  }

  /**
   * 长轮询扫码状态。`status` 取值：
   * `wait` / `scaned` / `confirmed` / `expired` / `scaned_but_redirect` /
   * `need_verifycode` / `verify_code_blocked` / `binded_redirect`。
   * @param {string} qrcode 二维码 id。
   * @param {object} [opts] verifyCode / baseOverride / abortSignal。
   * @returns {Promise<{status: string, bot_token?: string, ilink_bot_id?: string, baseurl?: string,
   *   ilink_user_id?: string, redirect_host?: string}>}
   */
  async getQrcodeStatus(qrcode, opts = {}) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    if (opts.verifyCode) endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode)}`
    try {
      const text = await this.#get(endpoint, {
        timeoutMs: DEFAULT_LONG_POLL_MS,
        baseOverride: opts.baseOverride,
        abortSignal: opts.abortSignal,
        label: 'getQrcodeStatus',
      })
      return JSON.parse(text)
    } catch (error) {
      // 长轮询客户端超时属于正常控制流，等价于 wait。
      if (error?.name === 'AbortError') return { status: 'wait' }
      this.log('debug', `getQrcodeStatus 网络错误，按 wait 重试: ${String(error)}`)
      return { status: 'wait' }
    }
  }

  /**
   * 长轮询收消息。
   * @param {object} [params]
   * @param {string} [params.getUpdatesBuf] 上次的游标，首次为空串。
   * @param {number} [params.timeoutMs] 长轮询超时。
   * @param {AbortSignal} [params.abortSignal] 外部取消。
   * @returns {Promise<object>} `{ ret, msgs, get_updates_buf, longpolling_timeout_ms, errcode, errmsg }`
   */
  async getUpdates(params = {}) {
    const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_MS
    try {
      const text = await this.#post(
        'ilink/bot/getupdates',
        {
          get_updates_buf: params.getUpdatesBuf ?? '',
          base_info: this.#baseInfo(),
        },
        { timeoutMs, abortSignal: params.abortSignal, label: 'getUpdates' },
      )
      return parseLosslessJson(text)
    } catch (error) {
      // 超时/外部取消都是正常退出路径，返回空结果让上层决定是否继续。
      if (error?.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf ?? '' }
      }
      throw error
    }
  }

  /**
   * 发送一条消息。
   * @param {object} msg 完整 WeixinMessage。
   * @returns {Promise<{ret?: number, errmsg?: string, message_id?: string}>}
   */
  async sendMessage(msg) {
    const text = await this.#post(
      'ilink/bot/sendmessage',
      { msg, base_info: this.#baseInfo() },
      { timeoutMs: DEFAULT_API_MS, label: 'sendMessage' },
    )
    const resp = parseLosslessJson(text)
    if (resp.ret && resp.ret !== 0) {
      throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
    }
    return resp
  }

  /**
   * 发送纯文本。`contextToken` 必填，否则消息对不上会话。
   * @param {object} params to / text / contextToken / runId。
   * @returns {Promise<object>} 服务端响应。
   */
  async sendText(params) {
    const items = params.text
      ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
      : []
    return this.sendMessage({
      from_user_id: '',
      to_user_id: params.to,
      client_id: `dsh-clawbot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: params.contextToken || undefined,
      run_id: params.runId || undefined,
      ...(items.length ? { item_list: items } : {}),
    })
  }

  /**
   * 获取 bot 配置（里面带 typing_ticket）。
   * @param {string} ilinkUserId 对方 ilink 用户 id。
   * @param {string} [contextToken] 会话 token。
   * @returns {Promise<{ret?: number, errmsg?: string, typing_ticket?: string}>}
   */
  async getConfig(ilinkUserId, contextToken) {
    const text = await this.#post(
      'ilink/bot/getconfig',
      {
        ilink_user_id: ilinkUserId,
        ...(contextToken ? { context_token: contextToken } : {}),
        base_info: this.#baseInfo(),
      },
      { timeoutMs: DEFAULT_CONFIG_MS, label: 'getConfig' },
    )
    return JSON.parse(text)
  }

  /**
   * 发送“正在输入”。
   * @param {object} params ilinkUserId / typingTicket / status(1=typing,2=cancel)。
   * @returns {Promise<void>}
   */
  async sendTyping(params) {
    await this.#post(
      'ilink/bot/sendtyping',
      {
        ilink_user_id: params.ilinkUserId,
        typing_ticket: params.typingTicket,
        status: params.status ?? TypingStatus.TYPING,
        base_info: this.#baseInfo(),
      },
      { timeoutMs: DEFAULT_CONFIG_MS, label: 'sendTyping' },
    )
  }

  /**
   * 通知服务端本客户端启动。
   * @returns {Promise<object>}
   */
  async notifyStart() {
    const text = await this.#post(
      'ilink/bot/msg/notifystart',
      { base_info: this.#baseInfo() },
      { timeoutMs: DEFAULT_CONFIG_MS, label: 'notifyStart' },
    )
    return JSON.parse(text)
  }

  /**
   * 通知服务端本客户端停止。
   * @returns {Promise<object>}
   */
  async notifyStop() {
    const text = await this.#post(
      'ilink/bot/msg/notifystop',
      { base_info: this.#baseInfo() },
      { timeoutMs: DEFAULT_CONFIG_MS, label: 'notifyStop' },
    )
    return JSON.parse(text)
  }

  /**
   * 申请一个 CDN 预签名上传地址。
   * @param {object} params filekey / mediaType / toUserId / rawsize / rawfilemd5 /
   *   filesize / aeskey(hex) / noNeedThumb。
   * @returns {Promise<{upload_param?: string, upload_full_url?: string, thumb_upload_param?: string}>}
   */
  async getUploadUrl(params) {
    const text = await this.#post(
      'ilink/bot/getuploadurl',
      {
        filekey: params.filekey,
        media_type: params.mediaType,
        to_user_id: params.toUserId,
        rawsize: params.rawsize,
        rawfilemd5: params.rawfilemd5,
        filesize: params.filesize,
        ...(params.noNeedThumb === false
          ? {
              thumb_rawsize: params.thumbRawsize,
              thumb_rawfilemd5: params.thumbRawfilemd5,
              thumb_filesize: params.thumbFilesize,
            }
          : { no_need_thumb: true }),
        aeskey: params.aeskey,
        base_info: this.#baseInfo(),
      },
      { timeoutMs: DEFAULT_API_MS, label: 'getUploadUrl' },
    )
    return JSON.parse(text)
  }

  /**
   * 上传一张本地图片到微信 CDN，返回发消息所需的引用信息。
   *
   * 流程（与官方实现一致）：
   *   1. 随机 16 字节 AES key 与 filekey
   *   2. AES-128-ECB 加密明文（PKCS7 补齐）
   *   3. getuploadurl 拿预签名地址
   *   4. POST 密文到 CDN，从响应头 `x-encrypted-param` 取下载参数
   *
   * @param {object} params data(Buffer) / toUserId / cdnBaseUrl。
   * @returns {Promise<{downloadParam: string, aesKeyBase64: string,
   *   ciphertextSize: number, plaintextSize: number, filekey: string}>}
   */
  async uploadImage(params) {
    const data = params.data
    if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('上传内容为空')
    const cdnBase = params.cdnBaseUrl || CDN_BASE_URL

    const aesKey = randomBytes(16)
    const filekey = randomBytes(16).toString('hex')
    const rawfilemd5 = createHash('md5').update(data).digest('hex')
    const ciphertext = encryptAesEcb(data, aesKey)
    const filesize = ciphertext.length

    const uploadResp = await this.getUploadUrl({
      filekey,
      mediaType: UploadMediaType.IMAGE,
      toUserId: params.toUserId,
      rawsize: data.length,
      rawfilemd5,
      filesize,
      aeskey: aesKey.toString('hex'),
      noNeedThumb: true,
    })

    const fullUrl = typeof uploadResp?.upload_full_url === 'string'
      ? uploadResp.upload_full_url.trim()
      : ''
    const uploadParam = uploadResp?.upload_param
    let cdnUrl
    if (fullUrl) cdnUrl = fullUrl
    else if (uploadParam) {
      cdnUrl = `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}`
        + `&filekey=${encodeURIComponent(filekey)}`
    } else {
      throw new Error(`getUploadUrl 没有返回上传地址: ${JSON.stringify(uploadResp)}`)
    }

    // CDN 偶发 5xx，重试三次；4xx 是客户端问题，直接失败。
    let downloadParam
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(cdnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
        })
        if (res.status >= 400 && res.status < 500) {
          const msg = res.headers.get('x-error-message') ?? (await res.text())
          throw new Error(`CDN 上传客户端错误 ${res.status}: ${msg}`)
        }
        if (res.status !== 200) {
          const msg = res.headers.get('x-error-message') ?? `status ${res.status}`
          throw new Error(`CDN 上传服务端错误: ${msg}`)
        }
        downloadParam = res.headers.get('x-encrypted-param') ?? undefined
        if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param 头')
        break
      } catch (error) {
        lastError = error
        if (String(error?.message ?? '').includes('客户端错误')) throw error
        if (attempt < 3) {
          this.log('debug', `CDN 上传第 ${attempt} 次失败，重试: ${String(error)}`)
          await new Promise((r) => setTimeout(r, 300 * attempt))
        }
      }
    }
    if (!downloadParam) {
      throw lastError instanceof Error ? lastError : new Error('CDN 上传失败')
    }

    return {
      downloadParam,
      // 发消息时 aes_key 要 base64(hex 字符串)，不是 base64(原始 key)。
      aesKeyBase64: Buffer.from(aesKey.toString('hex')).toString('base64'),
      ciphertextSize: filesize,
      plaintextSize: data.length,
      filekey,
    }
  }

  /**
   * 发送一张图片（可带一段文字说明）。
   * @param {object} params to / data(Buffer) / text / contextToken / cdnBaseUrl。
   * @returns {Promise<object>} 服务端响应。
   */
  async sendImage(params) {
    const uploaded = await this.uploadImage({
      data: params.data,
      toUserId: params.to,
      cdnBaseUrl: params.cdnBaseUrl,
    })

    const items = []
    if (params.text) {
      items.push({ type: MessageItemType.TEXT, text_item: { text: params.text } })
    }
    items.push({
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: uploaded.aesKeyBase64,
          encrypt_type: 1,
        },
        // 官方实现这里填的是**密文**大小。
        mid_size: uploaded.ciphertextSize,
      },
    })

    // 图文各发一条，和官方实现一致（一条消息只放一个 item）。
    let last
    for (const item of items) {
      last = await this.sendMessage({
        from_user_id: '',
        to_user_id: params.to,
        client_id: `dsh-clawbot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: params.contextToken || undefined,
        item_list: [item],
      })
    }
    return last
  }
}

/**
 * AES-128-ECB 加密（PKCS7 补齐，Node 默认）。
 * @param {Buffer} plaintext 明文。
 * @param {Buffer} key 16 字节密钥。
 * @returns {Buffer} 密文。
 */
export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * AES-128-ECB 解密（PKCS7 去补齐）。
 * @param {Buffer} ciphertext 密文。
 * @param {Buffer} key 16 字节密钥。
 * @returns {Buffer} 明文。
 */
export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * 计算 AES-128-ECB + PKCS7 后的密文长度。
 * @param {number} plaintextSize 明文字节数。
 * @returns {number} 密文字节数（16 的倍数）。
 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/**
 * 解析 `CDNMedia.aes_key` 成 16 字节原始密钥。
 * 线上有两种编码：
 *   - base64(16 字节原始 key)           —— 图片常用
 *   - base64(16 字节 key 的 32 位 hex)  —— 文件/语音/视频常用
 * @param {string} aesKeyBase64 base64 字符串。
 * @returns {Buffer} 16 字节密钥。
 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 ?? ''), 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(
    `aes_key 必须解出 16 字节原始 key 或 32 字符 hex，实际 ${decoded.length} 字节`,
  )
}

/**
 * 从一条入站消息的某个 item 里下载并解密媒体。
 * @param {object} item MessageItem。
 * @param {object} [opts] cdnBaseUrl。
 * @returns {Promise<Buffer|null>} 明文；不是可下载媒体或信息不全时返回 null。
 */
export async function downloadInboundMedia(item, opts = {}) {
  const cdnBase = opts.cdnBaseUrl || CDN_BASE_URL
  const pick = () => {
    if (item?.type === MessageItemType.IMAGE) {
      const img = item.image_item
      if (!img?.media) return null
      // 图片优先用 image_item.aeskey（hex），退回 media.aes_key（base64）。
      const aesKeyBase64 = img.aeskey
        ? Buffer.from(img.aeskey, 'hex').toString('base64')
        : img.media.aes_key
      return { media: img.media, aesKeyBase64 }
    }
    if (item?.type === MessageItemType.FILE) {
      const f = item.file_item
      if (!f?.media) return null
      return { media: f.media, aesKeyBase64: f.media.aes_key, fileName: f.file_name }
    }
    return null
  }

  const picked = pick()
  if (!picked) return null
  const { media, aesKeyBase64 } = picked
  if (!media.encrypt_query_param && !media.full_url) return null

  let url
  if (media.full_url) url = media.full_url
  else {
    url = `${cdnBase}/download?encrypted_query_param=${
      encodeURIComponent(media.encrypt_query_param)}`
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`CDN 下载失败 ${res.status} ${res.statusText}`)
  const ciphertext = Buffer.from(await res.arrayBuffer())

  // 没有 key 说明这份媒体是明文存的。
  if (!aesKeyBase64) return ciphertext
  return decryptAesEcb(ciphertext, parseAesKey(aesKeyBase64))
}

/**
 * 从一条入站消息里抽出人类可读的文本。
 * 语音消息若带了 `voice_item.text`（微信侧的语音转文字）就直接用它。
 * @param {object} msg WeixinMessage。
 * @returns {string} 文本（可能为空串）。
 */
export function extractInboundText(msg) {
  const parts = []
  for (const item of msg?.item_list ?? []) {
    if (item?.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text)
    } else if (item?.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(`[语音] ${item.voice_item.text}`)
    } else if (item?.type === MessageItemType.IMAGE) {
      parts.push('[图片]')
    } else if (item?.type === MessageItemType.FILE) {
      parts.push(`[文件] ${item.file_item?.file_name ?? ''}`.trim())
    } else if (item?.type === MessageItemType.VIDEO) {
      parts.push('[视频]')
    }
  }
  return parts.join('\n').trim()
}

/**
 * 列出消息里的图片 item。
 * @param {object} msg WeixinMessage。
 * @returns {object[]} image item 数组。
 */
export function inboundImageItems(msg) {
  return (msg?.item_list ?? []).filter(
    (item) => item?.type === MessageItemType.IMAGE && item.image_item?.media,
  )
}

/**
 * 判断一条消息是否值得处理：必须是用户发来的。
 * @param {object} msg WeixinMessage。
 * @returns {boolean}
 */
export function isInboundUserMessage(msg) {
  return msg?.message_type === MessageType.USER
}
