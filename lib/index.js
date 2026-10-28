/**
 * dsh-wechat-clawbot — 宿主半边。
 *
 * 把微信 ClawBot（iLink）通道接进 DSH，支持**把某个对话绑定到微信**。
 *
 * 两种使用姿势：
 *
 *   A. 绑定模式（推荐）
 *      在任意对话里说「把这个对话绑定到微信」，agent 调用
 *      `wechat_bind_this_conversation` 工具 → 返回二维码链接 → 手机扫码 →
 *      此后微信消息直接进入**这个**会话。手机上看回复，电脑上看全部
 *      思考过程与工具调用。
 *
 *   B. 独立模式
 *      不绑定，每个微信联系人自动分配一个独立会话。
 *
 * 数据流：
 *
 *   微信 ──getupdates──▶ 本插件 ──followup()──▶ 目标会话的 agent
 *   微信 ◀──sendmessage── 本插件 ◀──session/event── 会话里 assistant 的输出
 *
 * 状态文件在 `$DSH_HOME/dsh-wechat-clawbot/state.json`，里面有 bot_token，
 * 权限按 0600 写。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

import {
  CDN_BASE_URL,
  FIXED_BASE_URL,
  ILinkClient,
  MessageItemType,
  downloadInboundMedia,
  extractInboundText,
  inboundImageItems,
  isInboundUserMessage,
} from './ilink.mjs'

import {
  IDLE_DEFAULTS,
  coerceMinutes,
  readIdleState,
  renderIdleMessage,
  writeIdleState,
} from './idle.mjs'

/**
 * 插件声明的服务依赖。cordis 只允许读取 inject 里声明过的服务。
 *
 *   agents      建/驱动会话（核心）
 *   webServer   给设置页开 HTTP 接口
 *   tools       注册绑定/发消息工具
 *   attachments 把微信图片落成 DSH 附件（可选能力，缺了降级为纯文本）
 */
const inject = ['agents', 'webServer', 'tools']

/** 插件名，同时用作状态目录名与路由前缀。 */
const name = 'dsh-wechat-clawbot'

/** 路由前缀。 */
const ROUTE_PREFIX = '/dsh-wechat-clawbot'

/** 单条微信消息的文本上限，超出切片发送。 */
const MAX_TEXT_CHUNK = 1800

/** 等一轮回复的最长时间。 */
const REPLY_TIMEOUT_MS = 300_000

/**
 * 微信侧的「主动回复窗口」：只接收 24 小时内有过互动的用户的回复。
 * 过了窗口就算 token 还在手里，带上去也会被拒 —— 读记录时要按它判新鲜度。
 */
const REPLY_WINDOW_MS = 24 * 60 * 60_000

/**
 * 待机心跳的最小触发间隔。
 *
 * 定时器到点后如果没有立即跑（比如正好在处理别的消息），
 * 用这个间隔重排一次，避免同一毫秒里堆叠多个心跳。
 */
const IDLE_TICK_MS = 15_000

/** 长轮询连续失败多少次后进入长退避。 */
const MAX_CONSECUTIVE_FAILURES = 3

/** 长退避时长。 */
const BACKOFF_MS = 30_000

/** 普通重试间隔。 */
const RETRY_MS = 2_000

/**
 * 两次空轮询之间的最小间隔。正常情况下 getupdates 会被服务端 hold 30 秒以上；
 * 网关异常或被限流时可能立刻返回空结果，不节流会退化成打满 CPU 的紧循环。
 */
const MIN_POLL_INTERVAL_MS = 1_000

/**
 * `getupdates` 返回这个 errcode 时，表示 bot token 已失效（session timeout）。
 * 官方插件里叫 STALE_TOKEN_ERRCODE。此时重试无意义，必须重新扫码登录。
 */
const STALE_TOKEN_ERRCODE = -14

/** 状态文件版本。 */
const STATE_VERSION = 2

/** 单张入站图片的大小上限（与官方实现一致：100MB）。 */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024

/**
 * 待绑定记录的有效期。用户扫码确认后要在微信里发首条消息来认领。
 * 给一天的量级：用户常常扫码后隔很久才重启 DSH，窗口太短会让绑定悄悄失效；
 * 但也不能无限期留着，否则几天后随手一条消息会串到别的对话上。
 */
const PENDING_BIND_TTL_MS = 12 * 60 * 60_000

/** DSH 家目录。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 状态目录。 */
function stateDir() {
  return path.join(dshHome(), name)
}

/** 状态文件路径。 */
function statePath() {
  return path.join(stateDir(), 'state.json')
}

/** 落盘微信图片的目录。 */
function mediaDir() {
  return path.join(stateDir(), 'media')
}

/**
 * 读状态文件。坏文件当作空状态。
 * @returns {object}
 */
function readState() {
  const empty = {
    version: STATE_VERSION,
    token: '',
    baseUrl: '',
    accountId: '',
    userId: '',
    getUpdatesBuf: '',
    cwd: '',
    enabled: true,
    /**
     * 绑定关系：微信用户 id → { sessionId, boundAt, label }。
     * 有绑定就进那个会话，没有就按独立模式新建。
     */
    bindings: {},
    /** 独立模式下的自动会话：微信用户 id → { sessionId, lastAt }。 */
    sessions: {},
    /** 待领取的绑定：一次性 code → { sessionId, createdAt, claimed }。 */
    pendingBinds: {},
    /**
     * 微信用户自己选的权限预设：微信用户 id → preset 名。
     * 没记录时用默认的 workspace-write（含自动拒绝）。
     */
    permissions: {},
    /**
     * 绑定的墓碑：微信用户 id → 删除时间戳。
     *
     * 用途：让「删除」这个操作能被合并逻辑看见。
     * 没有墓碑时，删掉绑定后 persist() 会按 boundAt 把磁盘上的旧记录
     * 又合并回来 —— 表现为「删不掉，会话一直指向旧对话」。
     */
    bindingTombstones: {},
    /**
     * 最近一次入站消息的 context_token：微信用户 id → { token, at }。
     *
     * 用途：`wechat_send_message` / `wechat_send_image` 主动推送时自动回带，
     * 保证消息落回同一个聊天窗口。微信只接收 24 小时内的回复，
     * 过期的记录和没有一样 —— 读的时候要按 at 判断新鲜度。
     */
    contextTokens: {},
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return empty
    return {
      version: STATE_VERSION,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : '',
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      getUpdatesBuf: typeof parsed.getUpdatesBuf === 'string' ? parsed.getUpdatesBuf : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      enabled: parsed.enabled !== false,
      bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      pendingBinds:
        parsed.pendingBinds && typeof parsed.pendingBinds === 'object' ? parsed.pendingBinds : {},
      permissions:
        parsed.permissions && typeof parsed.permissions === 'object' ? parsed.permissions : {},
      bindingTombstones:
        parsed.bindingTombstones && typeof parsed.bindingTombstones === 'object'
          ? parsed.bindingTombstones
          : {},
      contextTokens:
        parsed.contextTokens && typeof parsed.contextTokens === 'object' ? parsed.contextTokens : {},
    }
  } catch {
    return empty
  }
}

/**
 * 原子写状态文件，权限 0600（里面有 bot_token）。
 * @param {object} state 完整状态。
 */
function writeState(state) {
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = statePath()
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, target)
  try {
    fs.chmodSync(target, 0o600)
  } catch {
    // Windows 上 chmod 基本无效。
  }
}

/** TTL 之类的常量放在这里，便于测试引用。 */

/**
 * 微信端可以切换的权限预设。
 *
 * 每个预设对应 DSH 里 permission-presets 的一行配置：它把 sandbox 模式
 * 与 approval 策略打包在一起。`approval: 'never'` 意味着所有需要审批的
 * 操作都会被**自动拒绝**（DSH 内部把 never 解释成 rejected），
 * 这正是「微信端没人能点同意，所以必须自动拒绝」要的行为。
 */
const PERMISSION_PRESETS = {
  'read-only': {
    sandbox: 'read-only',
    approval: 'never',
    label: '只读（不能改文件）',
  },
  'workspace-write': {
    sandbox: 'workspace-write',
    approval: 'never',
    label: '仅工作区（工作区外自动拒绝）',
  },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    label: '完全权限（不限制）',
  },
}

/**
 * 从一句中文/英文里识别用户想设的权限。
 *
 * 微信里没法点按钮，所以让用户直接说「修改权限为完全权限」这类话。
 * 这里只做保守的关键词匹配：宁可不认，也不要误把普通聊天当成改权限。
 *
 * @param {string} text 用户消息。
 * @returns {{preset: string, label: string}|null} 识别结果，认不出返回 null。
 */
function parsePermissionCommand(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  // 必须先出现「权限」或「permission」字样，避免普通句子误触。
  if (!/权限|permission/i.test(raw)) return null

  // 「完全 / 全部 / 不受限 / full / danger」→ danger-full-access
  if (/完全|全部|不受限|无限|full|danger|unrestricted/i.test(raw)) {
    return { preset: 'danger-full-access', label: PERMISSION_PRESETS['danger-full-access'].label }
  }
  // 「只读 / 仅读 / readonly」→ read-only
  if (/只读|仅读|只.?能读|readonly|read-only|read only/i.test(raw)) {
    return { preset: 'read-only', label: PERMISSION_PRESETS['read-only'].label }
  }
  // 「工作区 / workspace / 仅在工作区」→ workspace-write
  if (/工作区|workspace|当前目录|项目目录/i.test(raw)) {
    return { preset: 'workspace-write', label: PERMISSION_PRESETS['workspace-write'].label }
  }
  // 只说了「改权限」但没说改成什么 → 回help（用 undefined 表示要帮助）
  if (/权限|permission/i.test(raw)) {
    return { preset: '', label: '' }
  }
  return null
}

/**
 * 造一条符合 DSH session v4 契约的用户消息。
 *
 * 为什么不直接 `agent.followup({ content, source })`：
 * session 的**持久化校验**（dsh-session 的 assertMessageEventShape）要求每条
 * message 事件满足：
 *   - `message.id` 是非空字符串
 *   - `message.role` 与事件类型匹配（user/message → "user"）
 *   - `message.source.kind` 是非空字符串
 *   - `message.content` 是数组
 *
 * 少任何一个，**内存里能写进去、但落盘后再读就报**
 * `session event at seq N lacks an identified message`，
 * 整个会话被判为 corrupt，历史加载失败。
 *
 * 官方用 `@deepseek-ai/dsh-llm` 的 `createUserMessage()` 来保证这些字段；
 * 第三方插件解析不到那个包（不在 profile 的 node_modules 里），
 * 所以这里按同样规则自己造 —— 关键就是**必须带 id 和 role**。
 *
 * @param {{content: object[], source: object}} input 内容块与来源。
 * @returns {object} 冻结前的一条完整消息。
 */
function createUserMessage(input) {
  return {
    id: randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source,
  }
}

/**
 * 由微信用户 id 推导稳定的会话 id（独立模式用）。
 * @param {string} fromUserId 形如 `xxx@im.wechat`。
 * @returns {string}
 */
function sessionIdFor(fromUserId) {
  const hash = createHash('sha256').update(String(fromUserId)).digest('hex').slice(0, 16)
  return `wechat-${hash}`
}

/** HTML 转义（设置页渲染用户可控的 label / userId 时用）。 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 渲染设置页。自包含单文件：无外部资源、无构建步骤，
 * 数据在服务端直接嵌进模板，页面脚本只做刷新轮询。
 * @param {object} data status 数据（bindings / contacts / stats / ...）。
 * @param {boolean} hasOrigin 请求是否带了 Origin 头（决定刷新轮询是否可行）。
 * @returns {string}
 */
function renderSettingsPage(data, hasOrigin) {
  const time = (ms) => {
    if (!ms) return '—'
    const diff = Date.now() - Number(ms)
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    return new Date(Number(ms)).toLocaleString('zh-CN')
  }
  const rows = data.bindings.length
    ? data.bindings.map((b) => `
      <tr>
        <td>
          <div class="name">${escapeHtml(b.name)}</div>
          <div class="sub">${escapeHtml(b.sessionId)}${b.label ? ` · 备注：${escapeHtml(b.label)}` : ''}</div>
        </td>
        <td class="mono">${escapeHtml(b.userId)}</td>
        <td>${time(b.boundAt)}</td>
        <td><span class="pill ${b.live ? 'ok' : 'dim'}">${b.live ? '会话在线' : '未唤醒'}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">当前没有绑定任何微信。在 DSH 对话里说「把这个对话绑定到微信」即可。</td></tr>'
  const contactRows = data.contacts.length
    ? data.contacts.map((c) => `
      <tr>
        <td>
          <div class="name">独立会话</div>
          <div class="sub mono">${escapeHtml(c.sessionId)}</div>
        </td>
        <td class="mono">${escapeHtml(c.userId)}</td>
        <td>${time(c.lastAt)}</td>
        <td><span class="pill ${c.live ? 'ok' : 'dim'}">${c.live ? '会话在线' : '未唤醒'}</span></td>
      </tr>`).join('')
    : ''
  const loginPill = data.loggedIn
    ? (data.needsRelogin
      ? '<span class="pill warn">登录已失效，需重新扫码</span>'
      : `<span class="pill ok">已登录${data.monitoring ? ' · 监听中' : ' · 未监听'}</span>`)
    : '<span class="pill dim">未登录</span>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信 ClawBot 设置</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #1c1e21; }
  @media (prefers-color-scheme: dark) { body { background: #17181a; color: #e8e8e8; } .card { background: #202225 !important; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lead { color: #6b7280; font-size: 13px; margin: 0 0 20px; }
  .card { background: #fff; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 600; color: #6b7280; font-size: 12px; padding: 8px 10px; border-bottom: 1px solid rgba(128,128,128,.2); }
  td { padding: 10px; border-bottom: 1px solid rgba(128,128,128,.12); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .name { font-weight: 600; }
  .sub { color: #9ca3af; font-size: 12px; margin-top: 2px; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
  .pill.ok { background: #d1fae5; color: #065f46; }
  .pill.warn { background: #fef3c7; color: #92400e; }
  .pill.dim { background: rgba(128,128,128,.15); color: inherit; opacity: .75; }
  .empty { text-align: center; color: #9ca3af; padding: 24px; }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; font-size: 13px; }
  .stats b { font-size: 18px; display: block; }
  .stats span { color: #6b7280; }
  .err { color: #b91c1c; font-size: 13px; margin-top: 8px; }
  a { color: #2563eb; }
</style>
</head>
<body>
<h1>微信 ClawBot</h1>
<p class="lead">${loginPill}　账号 <span class="mono">${escapeHtml(data.accountId || '—')}</span></p>

<div class="card">
  <h3 style="margin:0 0 12px; font-size:15px;">绑定的对话</h3>
  <table>
    <thead><tr><th>对话</th><th>微信用户</th><th>绑定时间</th><th>状态</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
${contactRows ? `
<div class="card">
  <h3 style="margin:0 0 12px; font-size:15px;">独立会话（未绑定联系人）</h3>
  <table>
    <thead><tr><th>对话</th><th>微信用户</th><th>最近消息</th><th>状态</th></tr></thead>
    <tbody>${contactRows}</tbody>
  </table>
</div>` : ''}
<div class="card">
  <h3 style="margin:0 0 12px; font-size:15px;">统计</h3>
  <div class="stats">
    <div><b>${data.stats.inbound}</b><span>收到消息</span></div>
    <div><b>${data.stats.outbound}</b><span>发出消息</span></div>
    <div><b>${data.stats.imagesIn}</b><span>收到图片</span></div>
    <div><b>${data.stats.imagesOut}</b><span>发出图片</span></div>
  </div>
  ${data.lastError ? `<div class="err">最近错误：${escapeHtml(data.lastError)}</div>` : ''}
</div>
<p class="lead">绑定 / 解绑在 DSH 对话里说「把这个对话绑定到微信」/「解除微信绑定」；运维改绑可用 <span class="mono">POST /dsh-wechat-clawbot/bind</span>。${hasOrigin ? '页面每 5 秒自动刷新。' : ''}</p>
${hasOrigin ? `<script>setTimeout(() => location.reload(), 5000)</script>` : ''}
</body>
</html>`
}

/**
 * 把内存里的绑定与磁盘上的合并，每个联系人取 `boundAt` 更新的那一份。
 *
 * 为什么需要：`persist()` 是整份覆盖。如果 DSH 运行期间有人（或另一个进程）
 * 直接改了 state.json 的绑定，下一次游标推进就会把那个改动冲掉 ——
 * 表现为「改了文件，一会儿又变回去」。这里按时间戳让磁盘的较新变更生效。
 *
 * 磁盘读不出来或结构异常时，直接返回内存的值（不能让合并逻辑把事情搞更糟）。
 *
 * @param {{bindings: Record<string, object>}} state 内存状态。
 * @returns {Record<string, object>} 合并后的绑定表。
 */
function mergeNewerBindings(state) {
  const memory = state.bindings ?? {}
  let disk
  try {
    disk = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch {
    return memory
  }
  const diskBindings = disk?.bindings
  if (!diskBindings || typeof diskBindings !== 'object') return memory

  // 墓碑：内存里主动删掉的绑定，记下时间戳，避免把磁盘上的旧记录又合并回来。
  // 没有这个机制时，`delete state.bindings[id]` 之后 persist() 会按 boundAt
  // 把磁盘上那条更「新」的记录重新放回来 —— 表现为「删不掉」。
  const tombstones = state.bindingTombstones ?? {}

  const merged = { ...memory }
  for (const [userId, diskRow] of Object.entries(diskBindings)) {
    if (!diskRow || typeof diskRow.sessionId !== 'string') continue
    const memoryRow = memory[userId]
    if (memoryRow) continue // 内存里有，保留内存的（调用方刚设置过）

    const diskTime = Number(diskRow.boundAt ?? 0)
    // 墓碑比磁盘记录新 → 这个绑定是被主动删掉的，不要合并回来。
    const tombTime = Number(tombstones[userId] ?? 0)
    if (tombTime >= diskTime) continue

    merged[userId] = {
      sessionId: diskRow.sessionId,
      boundAt: diskTime,
      label: diskRow.label ?? '',
    }
  }
  return merged
}

/**
 * 把长文本切成微信能接受的多段，尽量在换行处断。
 * @param {string} text 原始文本。
 * @param {number} [limit] 每段上限。
 * @returns {string[]}
 */
function chunkText(text, limit = MAX_TEXT_CHUNK) {
  const value = String(text ?? '')
  if (value.length <= limit) return value ? [value] : []
  const chunks = []
  let rest = value
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * 从 `assistant/message` 事件里抽出纯文本。
 * @param {object} data 事件 data。
 * @returns {string}
 */
function assistantTextOf(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 从 `assistant/message` 事件里抽出图片附件引用。
 * agent 如果调用了生图工具，返回的 image 块会随消息进入会话，这里把它们捞出来。
 * @param {object} data 事件 data。
 * @returns {object[]} attachment 引用数组。
 */
function assistantImagesOf(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return []
  const images = []
  for (const block of content) {
    if (block?.type !== 'image') continue
    const att = block.attachment
    if (!att?.attachmentId) continue
    images.push({
      attachmentId: att.attachmentId,
      mediaType: att.mediaType,
      name: att.name,
    })
  }
  return images
}

/** 读取并解析 JSON 请求体。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** 统一发送 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 统一发送 HTML 响应。 */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html),
  })
  res.end(html)
}

/**
 * 判断请求是否来自本机可信会话。这些路由能写 token，必须 fail-closed。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isTrustedRequest(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const extra = String(process.env.DSH_WECHAT_CLAWBOT_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (host !== '' && extra.includes(host)) return true

  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  if (!loopback) return false

  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {object} config 插件配置。
 */
function apply(ctx, config = {}) {
  const logger = ctx.logger
  const state = readState()

  /** 运行时状态。 */
  const runtime = {
    client: null,
    // 登录态必须从落盘状态里恢复。否则每次重启插件都以为自己未登录，
    // startMonitor() 直接返回，微信侧看到的就是「bot 离线」。
    token: state.token,
    baseUrl: state.baseUrl,
    accountId: state.accountId,
    userId: state.userId,
    getUpdatesBuf: state.getUpdatesBuf,
    monitoring: false,
    abort: null,
    lastError: '',
    /** token 已失效（errcode -14），需要用户重新扫码。 */
    needsRelogin: false,
    lastInboundAt: 0,
    lastOutboundAt: 0,
    inboundCount: 0,
    outboundCount: 0,
    imageInCount: 0,
    imageOutCount: 0,
    /** 登录中的二维码会话。 */
    login: null,
    /** 正在等回复的回合：sessionId → waiter。 */
    waiters: new Map(),
    /** 待机 / 定时任务的调度定时器。 */
    idleTimer: null,
    /** 正在跑一个 A 类消息回合（防止重入）。 */
    idleRunning: false,
    /** 已连续触发多少次待机（用于 maxChain 熔断）。 */
    idleChain: 0,
    /** 诊断计数：AI 主动调工具的频次 / 兜底次数 / 真正触发次数。 */
    idleToolCalls: 0,
    scheduleToolCalls: 0,
    autoArmedCount: 0,
    idleTriggerCount: 0,
    lastIdleTriggerAt: 0,
    /** 连续多少次被叫醒后 AI 保持沉默（用于 silentLimit 熔断）。 */
    idleSilentChain: 0,
    /** 静默熔断后暂停自动兜底。 */
    autoArmPaused: false,
  }

  /**
   * 待机状态（设置 + 定时任务 + 当前心跳）。
   *
   * 与 state.json 分开存：那份含 token（0600），而待机偏好变化频繁，
   * 混在一起会让每次心跳都重写一份敏感文件。
   */
  let idleState = readIdleState(name)

  /** 写待机状态并返回。 */
  const persistIdle = () => {
    idleState = writeIdleState(idleState, name)
    return idleState
  }

  /** 落盘状态。 */
  const persist = () => {
    // 绑定关系存在「磁盘比我新」的可能：用户可能在 DSH 运行时手工改过
    // state.json（或另一处代码改了它）。直接整份覆盖会把那种修改冲掉，
    // 这里先对比磁盘上的 boundAt，取更新的那份。
    const merged = mergeNewerBindings(state)
    writeState({
      version: STATE_VERSION,
      token: runtime.token,
      baseUrl: runtime.baseUrl,
      accountId: runtime.accountId,
      userId: runtime.userId,
      getUpdatesBuf: runtime.getUpdatesBuf,
      cwd: state.cwd,
      enabled: state.enabled,
      bindings: merged,
      sessions: state.sessions,
      pendingBinds: state.pendingBinds,
      permissions: state.permissions,
      bindingTombstones: state.bindingTombstones,
      contextTokens: state.contextTokens,
    })
    // 让内存与磁盘保持一致，避免下次又拿旧值覆盖。
    state.bindings = merged
  }

  /** 确保 client 实例与登录态一致。 */
  const ensureClient = () => {
    if (!runtime.client) {
      runtime.client = new ILinkClient({
        baseUrl: runtime.baseUrl || FIXED_BASE_URL,
        token: runtime.token,
        log: (level, msg) => {
          if (level === 'debug') logger.debug?.(msg)
          else logger.info?.(msg)
        },
      })
    } else {
      runtime.client.setSession({ baseUrl: runtime.baseUrl, token: runtime.token })
    }
    return runtime.client
  }

  /**
   * 注册一个等回复的 waiter。
   * @param {string} sessionId 会话 id。
   * @returns {{promise: Promise<object>, cancel: (reason?: string) => void}}
   */
  const waitForReply = (sessionId) => {
    let resolveFn
    let rejectFn
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    const waiter = {
      sessionId,
      chunks: [],
      images: [],
      /**
       * 显式的推送队列：agent 调用 `wechat_reply` 时往这里塞条目。
       * 一旦非空，就**只**推送这些，忽略自动收集的 chunks ——
       * 这正是「有选择地推送」的实现：模型自己决定发什么。
       */
      outbox: [],
      /**
       * 立即投递函数。由 handleInbound 注入，知道「发给谁、用哪个
       * context_token」。`wechat_reply` 有了它就能**当场发出去**，
       * 不必等整轮结束。
       */
      deliver: null,
      /** 已经通过 deliver 立即发出去的条数（避免 turn 结束时重复发）。 */
      sentCount: 0,
      settled: false,
      timer: null,
      finish() {
        if (waiter.settled) return
        waiter.settled = true
        if (waiter.timer) clearTimeout(waiter.timer)
        runtime.waiters.delete(sessionId)

        // 计算「还需要在 turn 结束时补发」的内容。
        //
        // 关键：wechat_reply 已经通过 deliver **立即发过**的条数记在
        // sentCount 里。这些不能再发一遍，否则微信上会重复收到。
        const pendingOutbox = waiter.outbox.slice(waiter.sentCount)
        const fallbackText = waiter.chunks.join('\n').trim()

        let messages
        if (waiter.outbox.length > 0) {
          // 用过 wechat_reply：只补发还没发出去的那部分；
          // 全部发过了就一条都不发（正文绝不能因为「有 outbox」而被带上）。
          messages = pendingOutbox
        } else {
          // 没用过 wechat_reply：整段回复作为一条消息发出。
          messages = fallbackText ? [fallbackText] : []
        }

        resolveFn({
          messages,
          images: waiter.images.slice(),
          usedOutbox: waiter.outbox.length > 0,
        })
      },
      fail(error) {
        if (waiter.settled) return
        waiter.settled = true
        if (waiter.timer) clearTimeout(waiter.timer)
        runtime.waiters.delete(sessionId)
        rejectFn(error)
      },
    }
    waiter.timer = setTimeout(() => waiter.finish(), REPLY_TIMEOUT_MS)
    runtime.waiters.set(sessionId, waiter)
    return {
      promise,
      // 暴露内部 waiter，让调用方可以注入 deliver（立即发送能力）。
      // 少了这个引用，waiter.deliver = ... 会加到一个空的外层对象上，
      // 真正的 waiter 拿不到 —— 表现为「立即发送」静默失效。
      waiter,
      cancel: (reason = '回复被取消') => waiter.fail(new Error(reason)),
    }
  }

  // ── 会话事件：收集 assistant 文本与图片，turn 结束时封口 ────────────────
  ctx.effect(() => {
    const offEvent = ctx.on('session/event', (session, event) => {
      const waiter = runtime.waiters.get(session?.id)
      if (!waiter) return
      if (event?.type === 'assistant/message') {
        const text = assistantTextOf(event.data)
        if (text) waiter.chunks.push(text)
        // 生图工具产出的图片会作为 image 块进入这条消息。
        for (const img of assistantImagesOf(event.data)) waiter.images.push(img)
        return
      }
      if (event?.type === 'turn/end') {
        const reason = event.data?.reason
        const text = waiter.chunks.join('\n').trim()
        // outbox 非空说明 agent 用 wechat_reply 显式指定了要推什么 ——
        // 即使这一轮没有任何 assistant 文本，也算是有内容可发。
        // （纯工具调用轮次常常没有可见文本，只靠 outbox。）
        if (text || waiter.images.length > 0 || waiter.outbox.length > 0) {
          waiter.finish()
          return
        }
        if (reason?.kind === 'error') {
          waiter.chunks.push(`（DSH 处理失败：${reason.error?.message ?? '未知错误'}）`)
        } else if (reason?.kind === 'aborted') {
          waiter.chunks.push('（已中止）')
        } else {
          waiter.chunks.push('（DSH 这一轮没有产生回复）')
        }
        waiter.finish()
      }
    })
    return () => {
      offEvent?.()
    }
  }, `${name}.session-events()`)

  /**
   * 取（或造）一个 live agent。
   * @param {string} sessionId 会话 id。
   * @param {object} [opts] cwd / label。
   * @returns {Promise<object>} Agent
   */
  const ensureAgent = async (sessionId, opts = {}) => {
    const live = ctx.agents.get(sessionId)
    if (live) return live

    const presets = ctx.get('agentPresets')
    const defaultModel = ctx.get('agentDefaultModel')
    const presetId = presets?.defaultId
    const selection = defaultModel?.currentSelection?.()

    const meta = { cwd: opts.cwd || state.cwd || process.cwd() }
    if (presetId) meta.agentPreset = presetId

    const agentOptions = selection
      ? { provider: selection.provider, model: selection.model }
      : undefined

    const setup = presetId
      ? async (agentCtx) => {
          await presets.mount(agentCtx, presetId)
        }
      : undefined

    try {
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
      logger.info?.(`微信 ClawBot: 已恢复会话 ${sessionId}`)
      return handle.agent
    } catch (error) {
      const message = String(error?.message ?? error)
      logger.debug?.(`微信 ClawBot: 会话 ${sessionId} 恢复失败（${message}）`)

      // 关键：要区分「没有历史」和「有历史但坏了」。
      //
      // 无历史 → 该 create 一个新会话。
      // 有历史但损坏（corrupt / lacks an identified message / failed validation）
      //   → **不能** create！同名会话仍然存在，create 会报
      //     session "..." already exists，用户看到的就是这句。
      //
      // 这种情况只能如实告诉用户会话坏了，让他决定是修还是弃。
      const isCorrupt = /corrupt|failed validation|lacks an identified|invalid event|no longer exists/i
        .test(message)
      if (isCorrupt) {
        throw new Error(
          `会话 ${sessionId} 的日志已损坏，无法打开：${message}\n`
          + '这条消息没有送进 agent。请在电脑端检查该会话，或解除绑定后重新绑定到一个新对话。',
        )
      }
    }

    const handle = await ctx.agents.create({ sessionId, agentOptions, meta, setup })
    logger.info?.(`微信 ClawBot: 新建会话 ${sessionId}`)
    return handle.agent
  }

  /**
   * 判断一个会话是否还「活着」：要么是当前进程里的 live agent，
   * 要么磁盘上还有它的日志文件。
   *
   * 为什么要这个：用户在 DSH 里删掉或归档对话后，日志目录会被移除，
   * 但插件的绑定表还留着那个 id。不做校验的话，每条微信消息都会
   * 往一个幽灵会话里发 —— 用户看到的现象是「发了消息，电脑上什么都没有」，
   * 而且重新扫码也救不回来（旧绑定还没清）。
   *
   * @param {string} sessionId 会话 id。
   * @returns {Promise<boolean>} 是否还可寻址。
   */
  const sessionAlive = async (sessionId) => {
    if (!sessionId) return false
    // 进程内有 live agent，肯定活着。
    try {
      if (ctx.agents.get(sessionId)) return true
    } catch {
      // 忽略
    }
    // 否则看磁盘上有没有日志文件。
    const root = path.join(dshHome(), 'sessions')
    if (!fs.existsSync(root)) {
      // sessions 根目录都不存在，说明这个环境还没落过盘 —— 无可判断。
      // 保守地当作「活着」，避免把正常绑定误删。
      return true
    }
    try {
      for (const projectDir of fs.readdirSync(root)) {
        const candidate = path.join(root, projectDir, sessionId, 'session.v4.jsonl.zstd')
        if (fs.existsSync(candidate)) return true
      }
    } catch {
      // 读目录出错：保守当活着。
      return true
    }
    // sessions 根存在，但翻遍了都没有这个会话 → 确实不存在。
    return false
  }

  /**
   * 确保某个会话被登记到它 cwd 对应的 workspace 里。
   *
   * 为什么需要：DSH 侧边栏按 workspace 分组。一个会话如果**不在任何
   * workspace 的 sessionIds 里**，就会被丢进「未分组」。
   *
   * 这在实际使用中真的会发生：会话日志损坏过（或缺 id/role 被修过）之后，
   * DSH 会把它从 workspace 列表里剔除，修好文件也不会自动登记回来。
   * 微信绑定的会话如果落到「未分组」，用户就很难找到它。
   *
   * 这里在每次驱动 agent 前顺手确认一次：不在就挂回去。
   * 失败只记日志，绝不阻断消息处理（分组是展示问题，不该影响功能）。
   *
   * @param {string} sessionId 会话 id。
   * @param {string} cwd 会话的工作目录。
   */
  const ensureWorkspaceMembership = async (sessionId, cwd) => {
    const registry = ctx.get('workspaceRegistry')
    if (!registry?.resolveByPath) return
    try {
      const workspace = await registry.resolveByPath(cwd)
      if (!workspace) {
        logger.debug?.(`微信 ClawBot: ${cwd} 没有对应 workspace，跳过分组`)
        return
      }
      const ids = workspace.sessionIds ?? workspace.record?.sessionIds ?? []
      if (Array.isArray(ids) && ids.includes(sessionId)) return
      await workspace.attachSession(sessionId)
      logger.info?.(`微信 ClawBot: 已把会话 ${sessionId} 重新登记到 workspace ${cwd}`)
    } catch (error) {
      logger.debug?.(
        `微信 ClawBot: 登记 workspace 失败（不影响消息处理）: ${error?.message ?? error}`,
      )
    }
  }

  /**
   * 这个微信会话该用什么权限。
   *
   * 默认是「仅工作区 + 自动拒绝」：工作区内可读写，工作区外需要审批的操作
   * 直接被拒（微信里没人能点同意）。用户在微信里说过「修改权限为…」之后，
   * 就用他指定的那个。
   *
   * @param {string} fromUserId 微信用户 id。
   * @returns {string} PERMISSION_PRESETS 的键。
   */
  const resolveWechatPermission = (fromUserId) => {
    const chosen = state.permissions?.[fromUserId]
    if (typeof chosen === 'string' && PERMISSION_PRESETS[chosen]) return chosen
    return 'workspace-write'
  }

  /**
   * 把权限预设应用到某个会话。
   *
   * 微信侧没有人能点「同意」，所以这里一律把 approval 设为 `never`：
   * DSH 在 `never` 策略下会把所有需要审批的操作直接判为 rejected，
   * 也就是**自动拒绝**，不会挂在那里等电脑前的人。
   *
   * sandbox 模式决定「哪些操作根本不需要审批」：
   *   - read-only         只能读
   *   - workspace-write   工作区内可写，工作区外被沙箱挡住
   *   - danger-full-access 不限制
   *
   * @param {object} agent live agent。
   * @param {string} presetName PERMISSION_PRESETS 的键。
   * @returns {{ok: boolean, preset: string, label: string, error?: string}}
   */
  const applyPermissionPreset = (agent, presetName) => {
    const preset = PERMISSION_PRESETS[presetName]
    if (!preset) {
      return { ok: false, preset: presetName, label: '', error: `未知权限预设: ${presetName}` }
    }
    const session = agent?.session
    if (!session) {
      return { ok: false, preset: presetName, label: preset.label, error: '没有可用会话' }
    }

    const applied = []

    // 1) 沙箱模式：决定工作区外能不能动。
    //    dsh-sandbox-policy 暴露 setMode；没有就退回 sandbox 服务的同名方法。
    try {
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const sandbox = ctx.get('sandbox')
      if (typeof sandboxPolicy?.setMode === 'function') {
        sandboxPolicy.setMode(session, preset.sandbox)
        applied.push('sandboxPolicy')
      } else if (typeof sandbox?.setMode === 'function') {
        sandbox.setMode(session, preset.sandbox)
        applied.push('sandbox')
      }
    } catch (error) {
      logger.debug?.(`微信 ClawBot: 设置 sandbox 模式失败: ${error?.message ?? error}`)
    }

    // 2) 审批策略：一律 never → 需要审批的操作被自动拒绝。
    try {
      const approval = ctx.get('approval')
      if (typeof approval?.setPolicy === 'function') {
        approval.setPolicy(agent, 'never')
        applied.push('approval:never')
      }
    } catch (error) {
      logger.debug?.(`微信 ClawBot: 设置 approval 策略失败: ${error?.message ?? error}`)
    }

    // 3) 也走一遍 permissionPresets，让 DSH 的权限选择器显示一致的值。
    try {
      const presets = ctx.get('permissionPresets')
      if (typeof presets?.set === 'function') {
        presets.set(session, presetName)
        applied.push('permissionPresets')
      }
    } catch (error) {
      logger.debug?.(`微信 ClawBot: permissionPresets.set 失败: ${error?.message ?? error}`)
    }

    logger.info?.(
      `微信 ClawBot: 会话 ${session.id} 权限设为 ${presetName}`
        + `（sandbox=${preset.sandbox}, approval=never→自动拒绝）`,
    )
    return { ok: applied.length > 0, preset: presetName, label: preset.label, applied }
  }

  /**
   * 对会话做一层「自动拒绝」兜底。
   *
   * 即使权限预设设置失败（不同 DSH 版本服务名可能不同），也要保证微信侧
   * 不会把操作挂住等人。这里挂一个 approval answerer，一律回 rejected。
   *
   * 注意：answerer 是 waterfall，只有排到它时才生效；权限预设若已把策略设成
   * never，DSH 根本不会走到 answerer，两者互为冗余。
   *
   * @returns {() => void} 卸载函数。
   */
  const installAutoDenyAnswerer = () => {
    const off = ctx.on('approval/request', () => 'rejected')
    return typeof off === 'function' ? off : () => {}
  }

  /**
   * 把微信图片落成 DSH 附件，返回可直接放进消息的 image 块。
   * @param {object} item image item。
   * @returns {Promise<object|null>} image content block，失败返回 null。
   */
  const inboundImageBlock = async (item) => {
    const attachments = ctx.get('attachments')
    if (!attachments?.saveImage) {
      logger.debug?.('微信 ClawBot: 没有 attachments 服务，图片降级为文字占位')
      return null
    }
    try {
      const data = await downloadInboundMedia(item, { cdnBaseUrl: CDN_BASE_URL })
      if (!data || data.length === 0) return null
      if (data.length > MAX_MEDIA_BYTES) {
        logger.warn?.(`微信 ClawBot: 图片超过 ${MAX_MEDIA_BYTES} 字节，跳过`)
        return null
      }
      // 嗅探格式：微信图片通常是 jpg/png，也有 webp。
      const mediaType = sniffImageType(data)
      if (!mediaType) {
        logger.warn?.('微信 ClawBot: 无法识别图片格式，跳过')
        return null
      }
      const ref = await attachments.saveImage({
        data,
        mediaType,
        name: `wechat-${Date.now()}.${mediaType.split('/')[1]}`,
      })
      runtime.imageInCount += 1
      return {
        type: 'image',
        attachment: {
          attachmentId: String(ref.attachmentId),
          mediaType: String(ref.mediaType ?? mediaType),
          bytes: Number(ref.bytes ?? data.length),
          width: Number(ref.width ?? 0),
          height: Number(ref.height ?? 0),
        },
      }
    } catch (error) {
      logger.warn?.(`微信 ClawBot: 图片下载/解密失败: ${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 由会话 id 反查对应的微信用户 id（绑定优先，其次独立会话表）。
   * @param {string} sessionId 会话 id。
   * @returns {string} 微信用户 id，找不到返回空串。
   */
  const userIdOfSession = (sessionId) => {
    if (!sessionId) return ''
    for (const [userId, row] of Object.entries(state.bindings)) {
      if (row?.sessionId === sessionId) return userId
    }
    for (const [userId, row] of Object.entries(state.sessions)) {
      if (row?.sessionId === sessionId) return userId
    }
    return ''
  }

  /**
   * 待机心跳 / 定时任务 ──────────────────────────────────────────────────
   *
   * 两件相关但不同的事：
  //
  //   1. **待机心跳**：AI 回复完微信消息后，自己决定「N 分钟后如果我还没被叫，
  //      就给我发一条 A 类消息，让我想想要不要主动说话」。
  //      这是让 AI 掌握「什么时候开口」的机制。
  //
  //   2. **定时任务**：用户说「10 分钟后叫我」，登记一个一次性任务，
  //      到点发 A 类消息。**不受**待机开关影响（那是用户的明确指令）。
  //
  // A 类消息 = 插件模拟用户发出来的一条消息（source.kind 仍是 user，
  // 但带 `via: '<插件名>-idle'` 标记，方便在日志里和真人消息区分）。

  /**
   * 发一条文本到微信并计数（待机路径共用）。
   * @param {string} to 微信用户 id。
   * @param {string} text 文本。
   * @param {string} contextToken 会话 token。
   */
  const sendIdleText = async (to, text, contextToken) => {
    await ensureClient().sendText({ to, text, contextToken })
    runtime.outboundCount += 1
    runtime.lastOutboundAt = Date.now()
  }

  /**
   * 把一条 A 类消息注入会话，让 agent 处理。
   *
   * 走和真实微信消息相同的 followup 路径，所以 agent 的思考、工具调用
   * 在电脑上都可见；区别只在于 source 上会标出这是插件的待机提醒。
   *
   * @param {object} params userId / sessionId / text / kind。
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  const injectIdleMessage = async ({ userId, sessionId, text, kind = 'idle' }) => {
    if (!userId || !sessionId) return { ok: false, reason: '缺少 userId / sessionId' }
    if (!(await sessionAlive(sessionId))) {
      logger.warn?.(`微信 ClawBot: 待机提醒的目标会话 ${sessionId} 不存在，跳过`)
      return { ok: false, reason: '会话不存在' }
    }

    const agent = await ensureAgent(sessionId, {
      label: state.bindings[userId]?.label,
    })

    // 和真实消息一样，先确认会话挂在 workspace 里（否则侧边栏落到「未分组」）。
    await ensureWorkspaceMembership(sessionId, state.cwd || process.cwd())

    const contextToken = resolveContextToken(userId, '')
    const replyWaiter = waitForReply(sessionId)
    const waiter = replyWaiter.waiter
    waiter.deliver = async (texts) => {
      let sent = 0
      for (const one of texts) {
        for (const chunk of chunkText(one)) {
          try {
            await sendIdleText(userId, chunk, contextToken)
            sent += 1
          } catch (error) {
            logger.warn?.(`微信 ClawBot: 待机回复发送失败: ${error?.message ?? error}`)
            throw error
          }
        }
      }
      waiter.sentCount += sent
      return sent
    }

    runtime.idleRunning = true
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'user',
          via: `${name}-${kind}`,
          wechatUserId: userId,
        },
      }))
      const reply = await replyWaiter.promise

      // ── 关键：待机是「提醒」，不是「命令他发言」─────────────────────
      //
      // 待机心跳被叫醒后，agent 完全可能决定「这次没什么想说的」。
      // 那种情况下它**不会**调用 wechat_reply / wechat_send_message，
      // 不会有 outbox —— 此时必须保持沉默。
      //
      // 早期实现把这一轮自动收集到的正文无条件发出去，等于逼它开口，
      // 于是每 5 分钟必来一句，变成骚扰。
      //
      // 定时任务是例外：用户明确说了「10 分钟后提醒我」，
      // 到点就该把话带到，所以照旧兜底发送。
      if (kind === 'idle') {
        if (reply.usedOutbox) {
          // agent 主动说了话（已经通过 deliver 立即发出）—— 顺带把
          // 可能产出的图片也发出去。
          for (const image of reply.images) {
            try {
              const bytes = await readAttachmentBytes(ctx, image.attachmentId)
              if (bytes) {
                await ensureClient().sendImage({
                  to: userId,
                  data: bytes,
                  contextToken,
                  cdnBaseUrl: CDN_BASE_URL,
                })
                runtime.imageOutCount += 1
              }
            } catch (error) {
              logger.warn?.(`微信 ClawBot: 待机回复发图失败: ${error?.message ?? error}`)
            }
          }
          logger.info?.('微信 ClawBot: 待机叫醒后 agent 选择主动发言')
        } else {
          logger.info?.(
            '微信 ClawBot: 待机叫醒后 agent 没有主动发言（未调 wechat_reply），保持沉默',
          )
        }
        return { ok: true, spoke: reply.usedOutbox }
      }

      // 定时任务：把内容发出去（图片先，文字后）。
      for (const image of reply.images) {
        try {
          const bytes = await readAttachmentBytes(ctx, image.attachmentId)
          if (bytes) {
            await ensureClient().sendImage({
              to: userId,
              data: bytes,
              contextToken,
              cdnBaseUrl: CDN_BASE_URL,
            })
            runtime.imageOutCount += 1
          }
        } catch (error) {
          logger.warn?.(`微信 ClawBot: 定时任务发图失败: ${error?.message ?? error}`)
        }
      }

      const messages = Array.isArray(reply.messages) && reply.messages.length > 0
        ? reply.messages
        : (reply.text ? [reply.text] : [])
      for (const message of messages) {
        for (const chunk of chunkText(message)) {
          try {
            await sendIdleText(userId, chunk, contextToken)
          } catch (error) {
            logger.warn?.(`微信 ClawBot: 定时任务发送失败: ${error?.message ?? error}`)
          }
        }
      }
      return { ok: true, spoke: messages.length > 0 || reply.images.length > 0 }
    } catch (error) {
      logger.warn?.(`微信 ClawBot: 待机回合失败: ${error?.message ?? error}`)
      return { ok: false, reason: String(error?.message ?? error) }
    } finally {
      runtime.idleRunning = false
    }
  }

  /**
   * 重排调度定时器：算出最近的待触发点（心跳或定时任务）。
   *
   * 用「一个定时器 + 每次重算」而不是每个任务一个 setTimeout：
   * 设置页改参数、用户说话取消待机、任务增删都只需要调一次这个函数。
   */
  const scheduleIdleTick = () => {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer)
      runtime.idleTimer = null
    }
    const now = Date.now()
    const candidates = []
    if (idleState.idle?.dueAt) candidates.push(idleState.idle.dueAt)
    for (const s of idleState.schedules) candidates.push(s.dueAt)
    if (candidates.length === 0) return
    const next = Math.min(...candidates)
    const delay = Math.max(250, Math.min(next - now, IDLE_TICK_MS * 200))
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null
      runIdleTick().catch((error) => {
        logger.warn?.(`微信 ClawBot: 待机调度出错: ${error?.message ?? error}`)
      })
    }, delay)
    // 别让这个定时器拖住进程退出。
    runtime.idleTimer.unref?.()
  }

  /**
   * 判断某个微信用户现在是否「正在跟 AI 对话」——
   * 有等待中的回复就说明这一轮还没结束，A 类消息要往后让。
   * @param {string} userId 微信用户 id。
   * @returns {boolean}
   */
  const userIsBusy = (userId) => {
    const sessionId = state.bindings[userId]?.sessionId
      ?? state.sessions[userId]?.sessionId
      ?? ''
    if (!sessionId) return false
    return runtime.waiters.has(sessionId) || runtime.idleRunning
  }

  /**
   * 到点执行：发心跳 / 跑定时任务。
   */
  const runIdleTick = async () => {
    const now = Date.now()

    // ── 1. 到点的定时任务（用户明确要求的「N 分钟后叫我」）──
    const dueTasks = idleState.schedules.filter((s) => s.dueAt <= now)
    if (dueTasks.length > 0) {
      idleState.schedules = idleState.schedules.filter((s) => s.dueAt > now)
      persistIdle()
      for (const task of dueTasks) {
        if (userIsBusy(task.userId)) {
          // 用户正聊着，延后一分钟再叫，别打断。
          task.dueAt = now + 60_000
          idleState.schedules.push(task)
          persistIdle()
          continue
        }
        logger.info?.(`微信 ClawBot: 定时任务到点（${task.id}）→ 发 A 类消息`)
        const text = task.message || renderIdleMessage(idleState.settings.idleMessage, 0)
        await injectIdleMessage({
          userId: task.userId,
          sessionId: task.sessionId,
          text,
          kind: 'schedule',
        })
      }
      scheduleIdleTick()
      return
    }

    // ── 2. 待机心跳 ──
    const idle = idleState.idle
    if (!idle?.dueAt || idle.dueAt > now) {
      scheduleIdleTick()
      return
    }

    // 开关被关掉 / 用户正忙 / 链路熔断 → 心跳作废，不再续。
    if (!idleState.settings.enabled || userIsBusy(idle.userId)) {
      idleState.idle = null
      persistIdle()
      scheduleIdleTick()
      return
    }

    const maxChain = Number(idleState.settings.maxChain ?? IDLE_DEFAULTS.maxChain)
    const nextChain = Number(idle.chain ?? 0) + 1
    if (maxChain > 0 && nextChain > maxChain) {
      logger.info?.(
        `微信 ClawBot: 待机心跳连续 ${nextChain - 1} 次未获回应，停止续跳`
        + `（maxChain=${maxChain}，可在设置页调整）`,
      )
      idleState.idle = null
      persistIdle()
      scheduleIdleTick()
      return
    }

    // 先清掉这次心跳，避免 agent 处理期间又触发一次。
    const minutes = idle.minutes || idleState.settings.defaultMinutes
    idleState.idle = null
    persistIdle()

    // A 类消息的正文：既要表达「过了一段时间没消息」，也要明确告诉 AI
    // 这不强迫它开口 —— 否则模型倾向于「有人说话就必须回」。
    const text = `${renderIdleMessage(idleState.settings.idleMessage, minutes)}`
      + '\n\n（这是插件代发的待机提醒，不是主人发的。'
      + '**你不需要回复这条提醒**：没什么想说的就什么都不做，这一轮不会有消息发到微信；'
      + '真想找他再说，或者调 wechat_idle 继续等。）'
    runtime.idleTriggerCount += 1
    runtime.lastIdleTriggerAt = Date.now()
    logger.info?.(`微信 ClawBot: 待机 ${minutes} 分钟到点，发 A 类消息`)

    const result = await injectIdleMessage({
      userId: idle.userId,
      sessionId: idle.sessionId,
      text,
      kind: 'idle',
    })

    // 只有真正跑成功且 agent 没有重新定待机时才记链长；
    // 新的待机由 AI 在回合里通过 wechat_idle 工具重新登记。
    if (result.ok && !idleState.idle) {
      runtime.idleChain = nextChain
      // 关键：AI 被叫醒后没说话，就累计「连续静默」次数。
      // 静默太多次说明它其实不想聊，别再拿自动兜底去打扰它。
      if (result.spoke) {
        runtime.idleSilentChain = 0
      } else {
        runtime.idleSilentChain += 1
        const limit = Number(idleState.settings.silentLimit ?? IDLE_DEFAULTS.silentLimit)
        if (limit > 0 && runtime.idleSilentChain >= limit) {
          logger.info?.(
            `微信 ClawBot: 连续 ${runtime.idleSilentChain} 次被叫醒都选择不说话，`
            + '停止自动兜底（AI 想继续等会自己续订）',
          )
          runtime.autoArmPaused = true
        }
      }
    }
    scheduleIdleTick()
  }

  /**
   * 给某个微信会话定一个待机心跳。
   * @param {object} params userId / sessionId / minutes / chain。
   * @returns {object} 登记结果。
   */
  const armIdle = ({ userId, sessionId, minutes, chain = 0 }) => {
    if (!idleState.settings.enabled) {
      return { ok: false, reason: '待机功能已在设置页关闭' }
    }
    const m = coerceMinutes(minutes, idleState.settings.defaultMinutes)
    idleState.idle = {
      userId,
      sessionId,
      minutes: m,
      dueAt: Date.now() + m * 60_000,
      chain: Number(chain) || 0,
      armedAt: Date.now(),
    }
    persistIdle()
    scheduleIdleTick()
    logger.info?.(`微信 ClawBot: 已给 ${userId} 定待机 ${m} 分钟`)
    return { ok: true, minutes: m, dueAt: idleState.idle.dueAt }
  }

  /** 取消待机心跳（用户说话 / AI 主动关掉时调用）。 */
  const disarmIdle = (reason = '') => {
    if (!idleState.idle) return false
    logger.info?.(`微信 ClawBot: 取消待机心跳${reason ? `（${reason}）` : ''}`)
    idleState.idle = null
    persistIdle()
    scheduleIdleTick()
    return true
  }

  /**
   * 这一轮 AI 有没有自己动过待机相关工具。
   * 键是 sessionId，值在每轮开始前清掉，`wechat_idle` 被调用时置位。
   */
  const idleTouched = new Set()

  /**
   * 一轮微信回复结束后的兜底：AI 没主动调 `wechat_idle` 就替它登记一次。
   *
   * 为什么需要兜底：`wechat_idle` 是纯主动性工具，模型在「聊得挺好但我该不该
   * 埋伏一手」这种判断上大多不会主动行动——实测 37 轮微信对话里 0 次调用。
   * 没有兜底，这个功能就永远躺在工具列表里没人用。
   *
   * 尊重 AI 的意图：这一轮它调过 `wechat_idle`（哪怕是为了改成 1 分钟）
   * 就不再干预；它也可以显式表达「不要待机」——那种情况见工具的 minutes=0 约定。
   *
   * @param {string} userId 微信用户 id。
   * @param {string} sessionId 会话 id。
   */
  const maybeAutoArmIdle = (userId, sessionId) => {
    if (!idleState.settings.enabled || idleState.settings.autoArm === false) return
    if (runtime.autoArmPaused) return
    if (idleTouched.has(sessionId)) return
    // 已经有一个别的心跳排着，就别覆盖。
    if (idleState.idle) return
    // 有到点的定时任务在排队，说明用户/ AI 已经安排了主动行为，不必再叠一层。
    if (idleState.schedules.some((s) => s.userId === userId)) return
    armIdle({
      userId,
      sessionId,
      minutes: idleState.settings.defaultMinutes,
      chain: runtime.idleChain,
    })
    runtime.autoArmedCount += 1
    logger.info?.(
      `微信 ClawBot: AI 未主动定待机，按默认 ${idleState.settings.defaultMinutes} 分钟兜底`
      + '（可在设置页关掉「自动待机」）',
    )
  }

  /**
   * 处理一条入站微信消息。
   * @param {object} msg WeixinMessage。
   */
  const handleInbound = async (msg) => {
    const fromUserId = String(msg.from_user_id ?? '')
    if (!fromUserId) return

    const text = extractInboundText(msg)
    const imageItems = inboundImageItems(msg)
    if (!text && imageItems.length === 0) {
      logger.debug?.(`微信 ${fromUserId}: 消息里没有可处理内容，跳过`)
      return
    }

    runtime.inboundCount += 1
    runtime.lastInboundAt = Date.now()

    // 真人说话了 → 待机心跳作废。
    //
    // 这正是「等下别喊我」的天然实现：用户只要开口，就说明他不想被叫，
    // 不需要额外的「取消」指令。AI 想继续待机，会在这一轮里重新登记。
    if (idleState.idle?.userId === fromUserId) {
      disarmIdle('用户发来新消息')
    }
    runtime.idleChain = 0
    // 用户回来了：静默熔断解除，自动兜底恢复。
    runtime.idleSilentChain = 0
    runtime.autoArmPaused = false
    // 新一轮开始，清掉「AI 这轮动过待机」的标记（会话 id 稍后才知道，
    // 所以这里按用户维度也清一次，见下方 sessionId 确定后的清理）。
    for (const key of [...idleTouched]) idleTouched.delete(key)

    // 决定这条消息进哪个会话，优先级从高到低：
    //   1. 有「待领取的绑定」→ 认领它（扫码绑定的第二步）。
    //      必须排在旧绑定之前：用户重新扫码往往就是要换一个对话，
    //      如果先看旧绑定，新扫的码永远不生效（这是真实踩过的坑）。
    //   2. 已有绑定 → 用绑定的那个会话（**前提是它还活着**）。
    //   3. 都没有 → 给这个联系人分配一个独立会话。
    const previousSessionId = state.bindings[fromUserId]?.sessionId
    let sessionId = previousSessionId
    if (claimPendingBind(fromUserId)) {
      sessionId = state.bindings[fromUserId]?.sessionId
      if (sessionId && previousSessionId && sessionId !== previousSessionId) {
        logger.info?.(
          `微信 ClawBot: ${fromUserId} 重新绑定，会话从 ${previousSessionId} 切换到 ${sessionId}`,
        )
      }
    }

    // ── 绑定的会话可能已经被删/归档了 ──────────────────────────────
    //
    // 真实踩到的坑：用户在 DSH 里删掉（或归档）了被绑定的对话，
    // 但插件的绑定表里还留着那个 sessionId。于是每条微信消息都往一个
    // 不存在的会话里发 —— 表现为「微信发了消息，电脑上看不到，也没回复」，
    // 而且换对话扫新码也救不回来（因为旧绑定还指向幽灵会话）。
    //
    // 这里做一次存在性校验：会话既不在 live 列表里、磁盘上也没有日志，
    // 就判定为失效，自动退回独立会话（保证消息至少能进一个真实会话），
    // 并明确记日志，让用户知道该重新绑定。
    if (sessionId && !(await sessionAlive(sessionId))) {
      logger.warn?.(
        `微信 ClawBot: 绑定的会话 ${sessionId} 已不存在（被删除或归档），`
        + '这条消息改走独立会话。请在电脑上重新绑定一次对话。',
      )
      unbindSession(fromUserId)
      sessionId = ''
    }

    if (!sessionId) {
      sessionId = state.sessions[fromUserId]?.sessionId ?? sessionIdFor(fromUserId)
      state.sessions[fromUserId] = { sessionId, lastAt: Date.now() }
    }
    persist()

    const client = ensureClient()
    const contextToken = msg.context_token

    // 记下最近的 context_token，主动推送（wechat_send_message / send_image）
    // 时自动回带 —— 不用 agent 自己记得传，消息也不会掉到别的聊天窗口。
    if (contextToken) {
      state.contextTokens[fromUserId] = { token: contextToken, at: Date.now() }
      persist()
    }

    // 微信端可以直接改权限（没有按钮可点，只能靠说）。
    // 命中「修改权限为完全权限」这类话术时本地处理，不打扰 agent。
    const permissionCommand = parsePermissionCommand(text)
    if (permissionCommand) {
      if (!permissionCommand.preset) {
        const lines = [
          '当前可用的权限（发送「修改权限为…」即可切换）：',
          ...Object.entries(PERMISSION_PRESETS).map(
            ([key, p]) => `· ${p.label}　→ 说「修改权限为${p.label.split('（')[0]}」`,
          ),
          '',
          '说明：微信端无法点「同意」，所以需要审批的操作一律自动拒绝；',
          '要放开某个范围，就切到对应的权限。',
        ]
        for (const chunk of chunkText(lines.join('\n'))) {
          await client.sendText({ to: fromUserId, text: chunk, contextToken })
          runtime.outboundCount += 1
        }
        runtime.lastOutboundAt = Date.now()
        return
      }

      try {
        const agent = await ensureAgent(sessionId, {
          label: state.bindings[fromUserId]?.label,
        })
        const result = applyPermissionPreset(agent, permissionCommand.preset)
        if (result.ok) {
          // 记住这个选择：以后的每条消息都会重新应用它（会话可能是新建的）。
          state.permissions[fromUserId] = permissionCommand.preset
          persist()
        }
        const replyText = result.ok
          ? `权限已切换为「${result.label}」。\n`
            + '需要审批的操作会自动拒绝，不会再挂起等你点同意。'
          : `权限切换失败：${result.error ?? '未知原因'}`
        for (const chunk of chunkText(replyText)) {
          await client.sendText({ to: fromUserId, text: chunk, contextToken })
          runtime.outboundCount += 1
        }
        runtime.lastOutboundAt = Date.now()
        logger.info?.(`微信 ${fromUserId}: 权限指令 -> ${permissionCommand.preset}`)
      } catch (error) {
        logger.warn?.(`微信 ${fromUserId}: 切换权限失败: ${error?.message ?? error}`)
        await client.sendText({
          to: fromUserId,
          text: `权限切换失败：${error?.message ?? error}`,
          contextToken,
        })
      }
      return
    }

    // 构造交给 agent 的内容：图片块 + 文本。
    const content = []
    for (const item of imageItems) {
      const block = await inboundImageBlock(item)
      if (block) content.push(block)
    }
    if (text) content.push({ type: 'text', text })
    if (content.length === 0) content.push({ type: 'text', text: '[图片]' })

    // “正在输入”是可选能力。
    let typingTicket = ''
    try {
      const cfg = await client.getConfig(fromUserId, contextToken)
      typingTicket = cfg?.typing_ticket ?? ''
      if (typingTicket) {
        await client.sendTyping({ ilinkUserId: fromUserId, typingTicket, status: 1 })
      }
    } catch (error) {
      logger.debug?.(`微信 ClawBot: typing 失败（忽略）: ${error?.message ?? error}`)
    }

    let reply = { messages: [], images: [] }
    try {
      // 先把会话挂回 workspace（否则它在侧边栏里会落到「未分组」）。
      // 失败不影响消息处理，所以放在 try 里且内部自己吞异常。
      await ensureWorkspaceMembership(sessionId, state.cwd || process.cwd())

      const agent = await ensureAgent(sessionId, {
        label: state.bindings[fromUserId]?.label,
      })

      // 微信侧没有人能点「同意」。所以除非用户显式在微信里改过权限，
      // 每个会话都先钉上「仅工作区 + 自动拒绝」：
      // 需要审批（比如越界写）的操作会被直接拒绝，而不是挂起等电脑前的人。
      const permission = resolveWechatPermission(fromUserId)
      const applied = applyPermissionPreset(agent, permission)
      if (!applied.ok) {
        logger.debug?.(`微信 ClawBot: 权限设置不完整（${applied.error ?? '部分服务缺失'}）`)
      }

      const replyWaiter = waitForReply(sessionId)
      const waiter = replyWaiter.waiter

      // 注入「立即投递」能力：wechat_reply 有了它就能当场把消息发到微信，
      // 而不是排队等整轮结束。
      //
      // 为什么必须这样：agent 一轮里可能连着调十几个工具、思考很久。
      // 如果只在 turn/end 时统一发送，用户在微信上会长时间一片空白，
      // 然后突然收到一大坨 —— 这正是之前踩到的体验问题。
      waiter.deliver = async (texts) => {
        let sent = 0
        for (const text of texts) {
          for (const chunk of chunkText(text)) {
            try {
              await client.sendText({ to: fromUserId, text: chunk, contextToken })
              runtime.outboundCount += 1
              runtime.lastOutboundAt = Date.now()
              sent += 1
            } catch (error) {
              logger.warn?.(`微信 ClawBot: 立即发送失败: ${error?.message ?? error}`)
              throw error
            }
          }
        }
        waiter.sentCount += sent
        return sent
      }

      agent.followup(createUserMessage({
        content,
        // 用 `kind: "user"` 而不是 `plugin:<包名>`。
        //
        // 两个约束同时成立：
        //   1. session v4 的持久化层拒绝字面量 `kind: "plugin"`
        //      （"format v4 message requires a producer-owned source kind"）；
        //   2. 但 DSH 前端只把 `kind === "user"` 的消息渲染成正常用户气泡，
        //      其他 kind 一律降级成折叠的「上下文注入」行 ——
        //      用户在电脑上根本看不到自己在微信里说了什么。
        //
        // 微信里发来的消息本质就是用户输入，用 `user` 既符合语义也符合显示预期。
        // 带上微信侧的标识，便于以后追溯来源。
        source: {
          kind: 'user',
          via: name,
          wechatUserId: fromUserId,
        },
      }))
      reply = await replyWaiter.promise
    } catch (error) {
      runtime.lastError = String(error?.message ?? error)
      logger.warn?.(`微信 ${fromUserId}: 处理失败: ${runtime.lastError}`)
      reply = {
        messages: [`（DSH 处理这条消息时出错：${error?.message ?? error}）`],
        images: [],
      }
    } finally {
      if (typingTicket) {
        try {
          await client.sendTyping({ ilinkUserId: fromUserId, typingTicket, status: 2 })
        } catch {
          // 取消失败无所谓。
        }
      }
    }

    // 先发图片（生图工具产出的），再把文字发出去。
    for (const image of reply.images) {
      try {
        const bytes = await readAttachmentBytes(ctx, image.attachmentId)
        if (bytes) {
          await client.sendImage({
            to: fromUserId,
            data: bytes,
            contextToken,
            cdnBaseUrl: CDN_BASE_URL,
          })
          runtime.imageOutCount += 1
        }
      } catch (error) {
        logger.warn?.(`微信 ClawBot: 发送图片失败: ${error?.message ?? error}`)
      }
    }

    // messages 是「要推送的消息列表」：可能是 agent 用 wechat_reply 显式声明
    // 的多条（每条单独发一条微信消息），也可能是自动收集的整段文本（一条）。
    const messages = Array.isArray(reply.messages) && reply.messages.length > 0
      ? reply.messages
      : (reply.text ? [reply.text] : [])

    if (messages.length === 0 && reply.images.length === 0) {
      // 这一轮没剩下要补发的内容。两种可能：
      //   1. wechat_reply 已经通过 deliver 立即发过了 → 什么都不用做（别发「无回复」！）
      //   2. 真的一句都没有 → 给用户一个明确答复，而不是静默
      if (reply.usedOutbox) {
        maybeAutoArmIdle(fromUserId, sessionId)
        return
      }
      await client.sendText({ to: fromUserId, text: '（无回复）', contextToken })
      runtime.outboundCount += 1
      runtime.lastOutboundAt = Date.now()
      maybeAutoArmIdle(fromUserId, sessionId)
      return
    }

    for (const message of messages) {
      for (const chunk of chunkText(message)) {
        await client.sendText({ to: fromUserId, text: chunk, contextToken })
        runtime.outboundCount += 1
        runtime.lastOutboundAt = Date.now()
      }
    }
    if (reply.images.length > 0) runtime.lastOutboundAt = Date.now()

    // 正常回复完了：如果 AI 自己没定待机，按设置替它兜底一次。
    maybeAutoArmIdle(fromUserId, sessionId)
  }

  /** 可被 abort 打断的 sleep。 */
  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })

  /**
   * 长轮询主循环。
   * @param {AbortSignal} signal 取消信号。
   */
  const monitorLoop = async (signal) => {
    if (runtime.monitoring) return
    if (!runtime.token) {
      logger.info?.('微信 ClawBot: 尚未登录，跳过监听')
      return
    }
    runtime.monitoring = true
    runtime.lastError = ''
    const client = ensureClient()
    logger.info?.(`微信 ClawBot: 开始监听（base=${runtime.baseUrl || FIXED_BASE_URL}）`)

    let failures = 0
    let nextTimeoutMs = 35_000

    try {
      await client.notifyStart().catch(() => {})
      while (!signal.aborted) {
        const pollStartedAt = Date.now()
        try {
          const resp = await client.getUpdates({
            getUpdatesBuf: runtime.getUpdatesBuf,
            timeoutMs: nextTimeoutMs,
            abortSignal: signal,
          })
          if (signal.aborted) break

          if (resp?.longpolling_timeout_ms > 0) nextTimeoutMs = resp.longpolling_timeout_ms

          const isError =
            (resp?.ret !== undefined && resp.ret !== 0) ||
            (resp?.errcode !== undefined && resp.errcode !== 0)
          if (isError) {
            // errcode -14 = "session timeout"：服务端判定 bot token 已失效。
            // 这时候再怎么重试都没用，必须让用户重新扫码登录。
            //
            // 官方插件的做法是「暂停 1 小时再重试」，但对用户来说等于
            // 干等一小时且不知道为什么。这里改成：直接停机 + 明确提示，
            // 让用户知道该重新扫码。
            const isStaleToken =
              resp?.errcode === STALE_TOKEN_ERRCODE || resp?.ret === STALE_TOKEN_ERRCODE
            if (isStaleToken) {
              runtime.lastError =
                `登录已失效（errcode ${STALE_TOKEN_ERRCODE} session timeout）：`
                + '请在设置页点「连接微信」重新扫码'
              runtime.needsRelogin = true
              logger.error?.(
                `微信 ClawBot: ${runtime.lastError}`,
              )
              // 清掉失效的 token，避免下次启动又拿着它空转。
              runtime.token = ''
              runtime.getUpdatesBuf = ''
              persist()
              break
            }

            failures += 1
            runtime.lastError =
              `getUpdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`
            logger.warn?.(
              `微信 ClawBot: ${runtime.lastError}（${failures}/${MAX_CONSECUTIVE_FAILURES}）`,
            )
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
              failures = 0
              await sleep(BACKOFF_MS, signal)
            } else {
              await sleep(RETRY_MS, signal)
            }
            continue
          }

          failures = 0
          if (resp?.get_updates_buf) {
            runtime.getUpdatesBuf = resp.get_updates_buf
            persist()
          }

          const inbound = resp?.msgs ?? []
          for (const msg of inbound) {
            if (!isInboundUserMessage(msg)) continue
            try {
              await handleInbound(msg)
            } catch (error) {
              runtime.lastError = String(error?.message ?? error)
              logger.warn?.(`微信 ClawBot: 单条消息处理失败: ${runtime.lastError}`)
            }
          }

          if (inbound.length === 0 && Date.now() - pollStartedAt < MIN_POLL_INTERVAL_MS) {
            await sleep(MIN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt), signal)
          }
        } catch (error) {
          if (signal.aborted) break
          failures += 1
          runtime.lastError = String(error?.message ?? error)
          logger.warn?.(
            `微信 ClawBot: 监听异常 ${runtime.lastError}（${failures}/${MAX_CONSECUTIVE_FAILURES}）`,
          )
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            failures = 0
            await sleep(BACKOFF_MS, signal)
          } else {
            await sleep(RETRY_MS, signal)
          }
        }
      }
    } finally {
      runtime.monitoring = false
      await client.notifyStop().catch(() => {})
      logger.info?.('微信 ClawBot: 监听已停止')
    }
  }

  /** 启动监听（幂等）。 */
  const startMonitor = () => {
    if (runtime.monitoring) return
    if (!runtime.token) return
    runtime.abort?.abort()
    const controller = new AbortController()
    runtime.abort = controller
    monitorLoop(controller.signal).catch((error) => {
      runtime.lastError = String(error?.message ?? error)
      logger.warn?.(`微信 ClawBot: 监听循环退出: ${runtime.lastError}`)
    })
  }

  /** 停止监听。 */
  const stopMonitor = async () => {
    runtime.abort?.abort()
    runtime.abort = null
    for (let i = 0; i < 20 && runtime.monitoring; i += 1) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  // ── 登录 ────────────────────────────────────────────────────────────────
  /**
   * 发起扫码登录。
   * @param {object} [opts] bindSessionId：登录成功后要绑定的会话。
   * @returns {Promise<object>}
   */
  const startLogin = async (opts = {}) => {
    const client = ensureClient()
    const localTokens = runtime.token ? [runtime.token] : []
    const qr = await client.getBotQrcode(localTokens)
    if (!qr?.qrcode || !qr?.qrcode_img_content) {
      throw new Error(`未拿到二维码：${JSON.stringify(qr)}`)
    }

    // 如果这次登录是“绑定某个对话”触发的，生成一次性 code，
    // 扫码确认后用它把首条消息归到该会话。
    let bindCode = ''
    if (opts.bindSessionId) {
      bindCode = Math.random().toString(36).slice(2, 10)
      state.pendingBinds[bindCode] = {
        sessionId: opts.bindSessionId,
        label: opts.label ?? '',
        createdAt: Date.now(),
        claimed: false,
      }
      persist()
    }

    const login = {
      qrcode: qr.qrcode,
      url: qr.qrcode_img_content,
      startedAt: Date.now(),
      status: 'wait',
      currentBaseUrl: FIXED_BASE_URL,
      verifyCode: '',
      bindCode,
      bindSessionId: opts.bindSessionId ?? '',
    }
    runtime.login?.abort?.abort()
    if (runtime.login?.timer) clearTimeout(runtime.login.timer)
    login.abort = new AbortController()
    runtime.login = login
    return {
      ok: true,
      url: login.url,
      qrcode: login.qrcode,
      status: login.status,
      bindCode,
      message: '用手机微信扫描这个二维码，或在手机上打开该链接完成连接。',
    }
  }

  /**
   * 推进一次扫码状态。
   * @returns {Promise<object>}
   */
  const pollLoginOnce = async () => {
    const login = runtime.login
    if (!login) return { ok: false, status: 'idle', message: '没有进行中的登录，请先发起登录。' }
    if (Date.now() - login.startedAt > 5 * 60_000) {
      runtime.login = null
      return { ok: false, status: 'expired', message: '二维码已过期，请重新发起登录。' }
    }

    const client = ensureClient()
    let status
    try {
      status = await client.getQrcodeStatus(login.qrcode, {
        verifyCode: login.verifyCode || undefined,
        baseOverride: login.currentBaseUrl,
        abortSignal: login.abort.signal,
      })
    } catch (error) {
      return { ok: true, status: login.status, message: `轮询失败，重试中：${error?.message ?? error}` }
    }

    if (runtime.login !== login) return { ok: false, status: 'cancelled', message: '登录已取消。' }
    login.status = status?.status ?? 'wait'

    switch (login.status) {
      case 'scaned_but_redirect': {
        if (status.redirect_host) {
          login.currentBaseUrl = `https://${status.redirect_host}`
          logger.info?.(`微信 ClawBot: 登录 IDC 重定向到 ${status.redirect_host}`)
        }
        return { ok: true, status: 'wait', message: '已扫码，正在切换接入点…' }
      }
      case 'confirmed': {
        if (!status.ilink_bot_id) {
          runtime.login = null
          return { ok: false, status: 'error', message: '登录确认但服务端未返回 bot id。' }
        }
        const previousBaseUrl = runtime.baseUrl
        runtime.token = status.bot_token ?? ''
        runtime.baseUrl = status.baseurl || FIXED_BASE_URL
        runtime.accountId = status.ilink_bot_id ?? ''
        runtime.userId = status.ilink_user_id ?? ''
        runtime.getUpdatesBuf = ''
        // 重新登录成功，清掉「需要重新扫码」标记与上一次的错误。
        runtime.needsRelogin = false
        runtime.lastError = ''
        const bindCode = login.bindCode
        const bindSessionId = login.bindSessionId
        const loginUserId = status.ilink_user_id ?? ''
        runtime.login = null
        persist()

        // ── 关键：扫码确认就**立即完成绑定**，不再等首条消息 ──────────
        //
        // 早期设计是「扫码后等这个微信发来首条消息，再认领 pendingBind」。
        // 这套两段式在实践中反复失败，原因是它依赖一串脆弱的巧合：
        //   1. 服务端可能返回 `binded_redirect`（这个微信以前连过本 DSH），
        //      那样 `ilink_user_id` 为空，根本不知道是谁在扫，认领无从谈起；
        //   2. 用户扫完不一定马上发消息，pendingBind 就悬在那里；
        //   3. token 一旦失效（-14），消息收不到，认领永远不会发生。
        //
        // 现在只要服务端给出了 `ilink_user_id`（谁知道是谁扫的），
        // 就直接把「这个微信 → bindSessionId」写进绑定表。
        let bound = false
        if (bindSessionId && loginUserId) {
          bindSession(runtime.userId, bindSessionId, '')
          bound = true
          logger.info?.(
            `微信 ClawBot: 扫码确认，已把 ${loginUserId} 直接绑定到 ${bindSessionId}`,
          )
        } else if (bindSessionId && !loginUserId) {
          logger.warn?.(
            '微信 ClawBot: 扫码确认但服务端没返回 ilink_user_id，'
            + '无法立即绑定，仍要靠首条消息认领',
          )
        }

        if (runtime.monitoring && previousBaseUrl !== runtime.baseUrl) await stopMonitor()
        startMonitor()
        return {
          ok: true,
          status: 'confirmed',
          bound,
          boundSessionId: bound ? bindSessionId : '',
          message: bound
            ? '连接成功，已绑定到当前对话。现在去微信发消息即可。'
            : (bindSessionId
              ? '连接成功。在微信里给这个 bot 发任意消息即可完成绑定。'
              : '连接成功，微信 ClawBot 已接入 DSH。'),
          accountId: runtime.accountId,
          bindCode,
        }
      }
      case 'binded_redirect': {
        // 这个微信以前连过本 DSH，服务端不再下发新 token。
        //
        // 早期这里直接返回「无需重复连接」就完事了 —— 那是个 bug：
        // 如果用户这次是**想换一个对话**，目标会话就被丢掉了，
        // pendingBind 永远不被认领，绑定一直停在旧对话。
        //
        // 正确做法：既然这次登录带着 bindSessionId，就照样把它绑过去。
        const bindCode = login.bindCode
        const bindSessionId = login.bindSessionId
        runtime.login = null
        if (bindSessionId) {
          // binded_redirect 拿不到 ilink_user_id 时，退回「已知的绑定用户」。
          // 本 DSH 通常只服务一个微信，取现有绑定里的 key 是安全的。
          const knownUser = runtime.userId || Object.keys(state.bindings)[0] || ''
          if (knownUser) {
            bindSession(knownUser, bindSessionId, '')
            logger.info?.(
              `微信 ClawBot: binded_redirect，已把 ${knownUser} 改绑到 ${bindSessionId}`,
            )
            return {
              ok: true,
              status: 'binded',
              bound: true,
              boundSessionId: bindSessionId,
              message: '这个微信已连接过，已把它改绑到当前对话。去微信发消息即可。',
            }
          }
          logger.warn?.(
            '微信 ClawBot: binded_redirect 但不知道是哪个微信，'
            + '无法自动改绑，请在设置页解除旧绑定后重试',
          )
        }
        return {
          ok: true,
          status: 'binded',
          bound: false,
          message: '这个微信已经连接过本 DSH，无需重复连接。',
        }
      }
      case 'expired': {
        runtime.login = null
        return { ok: false, status: 'expired', message: '二维码已过期，请重新发起登录。' }
      }
      case 'need_verifycode': {
        return {
          ok: true,
          status: 'need_verifycode',
          message: '手机上需要输入配对数字，请填写后继续。',
        }
      }
      case 'verify_code_blocked': {
        runtime.login = null
        return { ok: false, status: 'blocked', message: '配对码错误次数过多，请稍后再试。' }
      }
      case 'scaned': {
        return { ok: true, status: 'scaned', message: '已扫码，请在手机上确认。' }
      }
      default:
        return { ok: true, status: 'wait', message: '等待扫码…' }
    }
  }

  // 状态接口与对话工具的后台轮询共用同一次请求，避免重复处理确认结果。
  const pollLogin = () => {
    const login = runtime.login
    if (!login) return Promise.resolve({ ok: false, status: 'idle', message: '没有进行中的登录，请先发起登录。' })
    if (!login.pollPromise) {
      login.pollPromise = pollLoginOnce().finally(() => { login.pollPromise = null })
    }
    return login.pollPromise
  }

  const watchToolLogin = (login) => {
    const tick = async () => {
      if (runtime.login !== login) return
      try {
        await pollLogin()
      } catch (error) {
        logger.warn?.(`微信 ClawBot: 登录轮询失败: ${error?.message ?? error}`)
      }
      if (runtime.login === login) {
        login.timer = setTimeout(tick, 1000)
        login.timer.unref?.()
      }
    }
    login.timer = setTimeout(tick, 1000)
    login.timer.unref?.()
  }

  /** 提交配对码。 */
  const submitVerifyCode = async (code) => {
    if (!runtime.login) return { ok: false, message: '没有进行中的登录。' }
    runtime.login.verifyCode = String(code ?? '').trim()
    return pollLogin()
  }

  /** 断开连接。 */
  const logout = async () => {
    await stopMonitor()
    runtime.login?.abort?.abort()
    if (runtime.login?.timer) clearTimeout(runtime.login.timer)
    runtime.token = ''
    runtime.baseUrl = ''
    runtime.accountId = ''
    runtime.userId = ''
    runtime.getUpdatesBuf = ''
    runtime.login = null
    runtime.client = null
    persist()
    return { ok: true, message: '已断开连接。' }
  }

  /**
   * 主动推送的 context_token：优先用调用方显式传的，否则取记住的那份
   * （24 小时内有效——微信只收 24h 内的回复，过期的 token 带了也没用）。
   * @param {string} to 微信用户 id。
   * @param {string} [explicit] 调用方显式指定的 token。
   * @returns {string} 可用的 context_token，拿不到就空串。
   */
  const resolveContextToken = (to, explicit) => {
    if (explicit) return explicit
    const rec = state.contextTokens?.[to]
    if (!rec?.token) return ''
    if (Date.now() - Number(rec.at ?? 0) > REPLY_WINDOW_MS) return ''
    return rec.token
  }

  /**
   * 主动给某个微信用户发多条文本消息（自动切片、自动回带 context_token）。
   * @param {object} params to / messages(string[]) 或 text / contextToken。
   * @returns {Promise<object>}
   */
  const sendToUser = async (params) => {
    if (!runtime.token) throw new Error('微信 ClawBot 尚未登录。')
    const client = ensureClient()
    const contextToken = resolveContextToken(params.to, params.contextToken)
    const source = Array.isArray(params.messages) ? params.messages : [params.text]
    const chunks = source.flatMap((m) => chunkText(m))
    if (chunks.length === 0) throw new Error('消息内容为空。')
    for (const chunk of chunks) {
      await client.sendText({ to: params.to, text: chunk, contextToken })
      runtime.outboundCount += 1
      runtime.lastOutboundAt = Date.now()
    }
    return { ok: true, chunks: chunks.length }
  }

  /**
   * 主动给某个微信用户发一张本地图片（可带一句配文）。
   * 走和入站图片相同的 AES 加密上传 + sendmessage 路径。
   * @param {object} params to / imagePath / caption / contextToken。
   * @returns {Promise<object>}
   */
  const sendImageToUser = async (params) => {
    if (!runtime.token) throw new Error('微信 ClawBot 尚未登录。')
    const imagePath = String(params.imagePath ?? '').trim()
    if (!imagePath) throw new Error('需要 imagePath（本地图片的绝对路径）。')
    const data = fs.readFileSync(imagePath)
    if (data.length > MAX_MEDIA_BYTES) throw new Error('图片超过大小上限。')
    const client = ensureClient()
    const resp = await client.sendImage({
      to: params.to,
      data,
      text: params.caption || '',
      contextToken: resolveContextToken(params.to, params.contextToken),
      cdnBaseUrl: CDN_BASE_URL,
    })
    runtime.imageOutCount += 1
    runtime.lastOutboundAt = Date.now()
    return { ok: true, messageId: resp?.message_id ?? '' }
  }

  /**
   * 把一个会话绑定到某个微信用户（内部用）。
   * @param {string} fromUserId 微信用户 id。
   * @param {string} sessionId 会话 id。
   * @param {string} [label] 备注。
   */
  const bindSession = (fromUserId, sessionId, label = '') => {
    // 防护：空 id 会写入一个无意义甚至覆盖性的键，导致后续完全对不上。
    if (!fromUserId || typeof fromUserId !== 'string') {
      throw new Error('bindSession 需要非空的微信用户 id')
    }
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('bindSession 需要非空的会话 id')
    }
    state.bindings[fromUserId] = { sessionId, boundAt: Date.now(), label }
    // 绑定后清掉独立模式的会话记录，避免两套映射打架。
    delete state.sessions[fromUserId]
    // 重新绑定：清掉该用户的墓碑（否则合并逻辑会把这次的新绑定当成"已删除"）。
    if (state.bindingTombstones) delete state.bindingTombstones[fromUserId]
    persist()
    logger.info?.(`微信 ClawBot: 已把 ${fromUserId} 绑定到会话 ${sessionId}`)
  }

  /**
   * 解除某个微信的绑定（带墓碑，确保真的删得掉）。
   *
   * 为什么需要墓碑：`persist()` 会把内存与磁盘的绑定按 `boundAt` 合并。
   * 单纯 `delete state.bindings[id]` 没有时间戳，磁盘上那条旧记录会被
   * 重新合并回来 —— 表现为「删不掉，消息还是进旧对话」。
   *
   * 用函数声明（而不是 const）是为了在它被定义之前就能被调用，
   * 避免 TDZ 问题。
   *
   * @param {string} fromUserId 微信用户 id。
   * @returns {boolean} 是否真的删掉了（原本不存在则返回 false）。
   */
  function unbindSession(fromUserId) {
    if (!state.bindings?.[fromUserId]) return false
    delete state.bindings[fromUserId]
    if (!state.bindingTombstones) state.bindingTombstones = {}
    state.bindingTombstones[fromUserId] = Date.now()
    persist()
    logger.info?.(`微信 ClawBot: 已解除 ${fromUserId} 的绑定`)
    return true
  }

  /**
   * 首条入站消息认领待绑定记录。
   *
   * 扫码只能确认「谁连进来了」，拿不到「要绑到哪个对话」，所以绑定工具先写一条
   * 带 sessionId 的待领取记录，等这个微信发来首条消息时在这里认领。
   *
   * 多条待领取时取**最新**的一条（用户最近一次扫码的那个对话）——重新扫码
   * 通常就是想换一个对话，所以新的必须盖过旧的。
   *
   * @param {string} fromUserId 微信用户 id。
   * @returns {boolean} 是否认领成功。
   */
  const claimPendingBind = (fromUserId) => {
    const now = Date.now()
    const all = Object.entries(state.pendingBinds ?? {})
      .filter(([, row]) => row && typeof row.sessionId === 'string')

    // 先统一清掉过期的，避免旧记录长期堆积（二维码只有约 2 分钟有效期，
    // 但用户可能隔几分钟才扫码，TTL 给足一点）。
    let purged = false
    for (const [code, row] of all) {
      if (now - (row.createdAt ?? 0) > PENDING_BIND_TTL_MS) {
        delete state.pendingBinds[code]
        purged = true
        logger.debug?.(`微信 ClawBot: 待绑定 ${code} 已过期，丢弃`)
      }
    }
    if (purged) persist()

    const entries = all
      .filter(([code]) => Object.hasOwn(state.pendingBinds, code))
      .filter(([, row]) => !row.claimed)
      .sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0))

    const newest = entries[0]
    if (!newest) return false

    const [code, row] = newest
    bindSession(fromUserId, row.sessionId, row.label ?? '')
    delete state.pendingBinds[code]
    persist()
    logger.info?.(`微信 ClawBot: ${fromUserId} 首条消息认领了绑定 ${code} → ${row.sessionId}`)
    return true
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  const tools = []

  /**
   * 把一行给人看的文字包成工具内容块。
   * 工具输出的 `render` 必须返回 ContentBlock[]（不是裸字符串），
   * 宿主会直接对它做 `content.some(...)`，返回字符串会抛
   * `content.some is not a function`。
   * @param {string} text 文本。
   * @returns {Array<object>} 内容块数组。
   */
  const textBlocks = (text) => [{ type: 'text', text: String(text ?? '') }]

  // 「把这个对话绑定到微信」
  if (config.enableBindTool !== false) {
    tools.push({
      name: 'wechat_bind_this_conversation',
      description:
        '把**当前这个对话**绑定到微信 ClawBot。'
        + '调用后会返回一个二维码链接，用户用手机微信扫码/打开链接确认后，'
        + '此后在微信里给这个 bot 发的消息会直接进入当前这个对话，'
        + '用户可以在手机上看到回复、在电脑上看到完整的思考过程与工具调用。'
        + '如果尚未登录微信，这个工具会同时完成登录与绑定。'
        + '注意：一个对话同时只能绑定一个微信用户；重复调用会刷出新的二维码。',
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: '可选备注，例如“主人的微信”，会显示在设置页',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '二维码链接，需交给用户扫描' },
            qrcode: { type: 'string', description: '二维码 id' },
            sessionId: { type: 'string', description: '被绑定的会话 id' },
            alreadyBound: { type: 'boolean', description: '该对话是否已经绑定过' },
            message: { type: 'string', description: '给用户看的操作说明' },
          },
          required: ['url', 'sessionId', 'message'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          if (value?.alreadyBound) {
            return textBlocks(`这个对话已经绑定到微信（会话 ${value.sessionId}）`)
          }
          return textBlocks(`请用微信扫码完成绑定：${value?.url ?? ''}`)
        },
      },
      async execute(args, exec) {
        // exec.agent.session.id 就是当前对话的会话 id —— 这是“绑定当前对话”的关键。
        const sessionId = String(exec?.agent?.session?.id ?? '')
        if (!sessionId) throw new Error('拿不到当前会话 id，无法绑定。')

        // 这个对话本身已经绑过某个微信：直接说清楚，不用再扫码。
        const boundToThis = Object.entries(state.bindings).find(
          ([, row]) => row?.sessionId === sessionId,
        )
        if (boundToThis) {
          return {
            url: '',
            sessionId,
            alreadyBound: true,
            message:
              `这个对话已经绑定到微信用户 ${boundToThis[0]}。`
              + '如需换一个微信，请先在设置页解除绑定。',
          }
        }

        // 注意：这里**不**因为「该微信已绑定到别的对话」就拒绝。
        // 用户重新扫同一个微信、想换到当前对话，是常见且合理的行为；
        // 拒绝会导致新码永远不生效、消息一直进旧对话
        // （真实踩过的坑：消息进错会话，新对话里看不到任何微信记录）。
        // 新产生的待绑定记录会在首条消息进来时覆盖旧绑定。
        const claimedByOther = Object.entries(state.bindings).find(
          ([, row]) => row?.sessionId !== sessionId,
        )

        const login = await startLogin({
          bindSessionId: sessionId,
          label: args?.note ?? '',
        })
        watchToolLogin(runtime.login)
        return {
          url: login.url,
          qrcode: login.qrcode,
          sessionId,
          alreadyBound: false,
          message:
            '请用手机微信扫描这个二维码（或在手机上打开该链接）并确认。'
            + '确认后，在微信里给这个 bot 发任意一条消息，就会把该微信绑定到当前对话。'
            + (claimedByOther
              ? '\n\n注意：这个微信当前绑定在另一个对话上，扫码后的首条消息会把它'
                + '改绑到当前对话（旧绑定会自动解除）。'
              : '')
            + `\n\n二维码链接：${login.url}`,
        }
      },
    })
  }

  // 「解除当前对话的绑定」
  if (config.enableBindTool !== false) {
    tools.push({
      name: 'wechat_unbind_this_conversation',
      description:
        '解除**当前这个对话**与微信的绑定。解除后微信消息不再进入此对话。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            unbound: { type: 'array', items: { type: 'string' }, description: '被解绑的微信用户' },
            message: { type: 'string' },
          },
          required: ['unbound', 'message'],
          additionalProperties: false,
        },
        render: (_args, value) => textBlocks(value?.message ?? '已解除绑定'),
      },
      async execute(_args, exec) {
        const sessionId = String(exec?.agent?.session?.id ?? '')
        const unbound = []
        for (const [userId, row] of Object.entries({ ...state.bindings })) {
          if (row?.sessionId === sessionId) {
            // 用 unbindSession 而不是直接 delete：它会写墓碑，
            // 否则 persist() 的合并逻辑会把这条绑定又"复活"回来。
            unbindSession(userId)
            unbound.push(userId)
          }
        }
        return {
          unbound,
          message: unbound.length > 0
            ? `已解除 ${unbound.length} 个微信与该对话的绑定。`
            : '这个对话当前没有绑定任何微信。',
        }
      },
    })
  }

  // 「这次回复推送什么」——支持多条、且可以只推其中一部分。
  tools.push({
    name: 'wechat_reply',
    description:
      '决定这一轮要推送到微信的消息。**在微信对话里回复用户时优先用它。**\n'
      + '· 传 messages 数组：每条会作为一条独立的微信消息发出，顺序保持。\n'
      + '· 一旦调用它，就**只**推送 messages 里的内容；你在正文里写的其他内容'
      + '（比如给电脑端看的长篇分析、命令输出、思考整理）不会发到微信。'
      + '这正好用于「电脑上写一大段，手机上只收关键几句」。\n'
      + '· 不调用它时，会把你这轮的完整回复整段发过去。\n'
      + '· 同一个微信会话里只调用一次即可，多条内容都放进 messages。',
    parameters: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: '要推送的消息列表，每条单独作为一条微信消息发送',
          items: { type: 'string' },
        },
      },
      required: ['messages'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          queued: { type: 'number', description: '本次发到微信的条数' },
          delivered: {
            type: 'boolean',
            description: '是否已当场发到微信（true=立即发送，false=排队等本轮结束）',
          },
        },
        required: ['queued'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlocks(
        `已发送 ${value?.queued ?? 0} 条微信消息`,
      ),
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.session?.id ?? '')
      if (!sessionId) throw new Error('拿不到当前会话 id')
      // 先校验参数，再找 waiter —— 参数错误应该报参数错误，不该被
      // 「没有等待中的回复」盖掉。
      const list = Array.isArray(args?.messages) ? args.messages : []
      const cleaned = list
        .map((m) => String(m ?? '').trim())
        .filter((m) => m.length > 0)
      if (cleaned.length === 0) throw new Error('messages 不能为空')
      const waiter = runtime.waiters.get(sessionId)
      if (!waiter) {
        throw new Error('当前没有等待中的微信回复（这个对话可能不是由微信消息触发的）')
      }

      // 优先**立即发送**：你在微信里等着，不该等 agent 把这一轮所有工具
      // 都调完才收到一句话。
      if (typeof waiter.deliver === 'function') {
        const sent = await waiter.deliver(cleaned)
        // 记录已发内容，turn 结束时不再重复发送。
        waiter.outbox.push(...cleaned)
        return { queued: sent, delivered: true }
      }

      // 没有 deliver（理论上不该发生）就退回入队，等 turn 结束统一发。
      waiter.outbox.push(...cleaned)
      return { queued: cleaned.length, delivered: false }
    },
  })

  // ── 待机心跳：AI 自己决定「过多久再被叫醒」 ──────────────────────────
  tools.push({
    name: 'wechat_idle',
    description:
      '给自己定一个**待机心跳**：N 分钟后，如果主人还没有发新消息，插件会模拟主人给你发一条'
      + '「过去 N 分钟了，没有任何消息」提醒（A 类消息）。\n'
      + '\n**这只是提醒，不是命令你发言。** 被叫醒后你可以：\n'
      + '· 觉得没什么想说的 → **什么都不用做**，这一轮不会有任何消息发到微信（推荐，很常见）；\n'
      + '· 真的想找他说话 → 调 `wechat_reply` / `wechat_send_image` / `wechat_send_message` 主动发；\n'
      + '· 想继续等他 → 再调一次本工具续订（不调就自然停止）。\n'
      + '注意：被叫醒那一轮你的正文不会自动发到微信——**不调发送工具就等于保持沉默**。\n'
      + '\n【什么时候该用】这是你在微信聊天里表达「我在、我想继续聊」的方式。以下情况**主动调用**：\n'
      + '· 这一轮聊得正热络，你刚问了主人一个问题、或话头明显还没结束（最常见）；\n'
      + '· 主人说「等一下」「我去忙会儿」「马上回来」——你自然地等他；\n'
      + '· 你想过一会儿提醒他某件事（喝水、休息、别熬夜），但不需要精确到点的定时任务。\n'
      + '\n【什么时候不要用】\n'
      + '· 主人明确说「睡了」「别喊我」「不用了」——别打扰；\n'
      + '· 对话已经自然收尾，没有真正想说的——不调就是最好的选择；\n'
      + '· 刚被叫醒且这轮没什么想说的——不要续订，让它停。\n'
      + '\n【规则】\n'
      + '· 每次被提醒后想继续等，就再调一次续订；**不调就自然停止**，不会一直缠着人。\n'
      + '· 主人一旦发来真实消息，待机自动作废（所以不用手动取消）。\n'
      + '· 分钟数默认取设置页的默认值（5 分钟）；拿不准就用默认值。\n'
      + '· 只在微信对话里用——对方在等你回话的场合。',
    parameters: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: '待机多少分钟后触发提醒。省略则用设置页的默认值。',
        },
        reason: {
          type: 'string',
          description: '可选：给自己看的备注（为什么定这个时长），不会发给主人。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          minutes: { type: 'number', description: '实际登记的分钟数' },
          dueAt: { type: 'number', description: '触发时间戳（毫秒）' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlocks(value?.message ?? ''),
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.session?.id ?? '')
      const userId = userIdOfSession(sessionId)
      if (!userId) {
        throw new Error('拿不到这个会话对应的微信用户（不在微信对话里）')
      }
      // 标记「这一轮 AI 自己动过待机」，避免回合结束时被自动兜底覆盖。
      idleTouched.add(sessionId)
      runtime.idleToolCalls += 1
      // AI 主动定待机 = 它还想继续等，静默熔断解除。
      runtime.idleSilentChain = 0
      runtime.autoArmPaused = false
      const result = armIdle({
        userId,
        sessionId,
        minutes: args?.minutes,
        chain: runtime.idleChain,
      })
      if (!result.ok) {
        return { ok: false, minutes: 0, dueAt: 0, message: `未能登记待机：${result.reason}` }
      }
      return {
        ok: true,
        minutes: result.minutes,
        dueAt: result.dueAt,
        message: `好的，${result.minutes} 分钟后如果主人没动静，我会来提醒你`
          + `（${new Date(result.dueAt).toLocaleTimeString('zh-CN')}）。`,
      }
    },
  })

  // ── 定时任务：用户明确说「N 分钟后叫我」──
  tools.push({
    name: 'wechat_schedule',
    description:
      '登记一个**定时任务**：N 分钟后给主人发一条提醒（A 类消息，让 agent 处理）。\n'
      + '· 用于用户明确要求的时间点提醒：「10 分钟后叫我」「半小时后提醒我喝水」。\n'
      + '· 与 `wechat_idle` 不同：定时任务**不受**待机开关影响，是用户的明确指令。\n'
      + '· 到点时如果用户正在对话中，会自动延后 1 分钟，不打断当前回合。\n'
      + '· `text` 省略时用设置页里的默认提醒文案。',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: '多少分钟后提醒（必填）' },
        text: { type: 'string', description: '可选：到点时要说的那句话（会作为 A 类消息正文）' },
      },
      required: ['minutes'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          dueAt: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlocks(value?.message ?? ''),
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.session?.id ?? '')
      const userId = userIdOfSession(sessionId)
      if (!userId) {
        throw new Error('拿不到这个会话对应的微信用户（不在微信对话里）')
      }
      const minutes = coerceMinutes(args?.minutes, idleState.settings.defaultMinutes)
      const task = {
        id: Math.random().toString(36).slice(2, 10),
        userId,
        sessionId,
        message: String(args?.text ?? '').trim(),
        dueAt: Date.now() + minutes * 60_000,
        createdAt: Date.now(),
      }
      idleState.schedules.push(task)
      runtime.scheduleToolCalls += 1
      persistIdle()
      scheduleIdleTick()
      return {
        ok: true,
        id: task.id,
        dueAt: task.dueAt,
        message: `已登记：${minutes} 分钟后提醒`
          + `（${new Date(task.dueAt).toLocaleTimeString('zh-CN')}）。`,
      }
    },
  })

  // 「从微信发消息」
  tools.push({
    name: 'wechat_send_message',
    description:
      '主动给微信用户推送文本消息，不需要等对方先发消息。**支持多条**：'
      + '传 `messages` 数组时每条会作为一条独立的微信消息发出（适合模拟真人连发）。'
      + '收件人 `to` 填对方的 ilink 用户 id（形如 xxx@im.wechat），可从微信 ClawBot 设置页看到。'
      + 'context_token 插件会自动回带（记录在最近 24 小时内发过消息的联系人上），'
      + '消息会落回原来的聊天窗口；也可以用 `contextToken` 显式指定。'
      + '注意微信侧限制：只接收 24 小时内的回复。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '微信用户的 ilink id，形如 xxx@im.wechat' },
        text: { type: 'string', description: '要发送的文本内容（与 messages 二选一），过长会自动分成多段' },
        messages: {
          type: 'array',
          description: '多条消息，每条独立发送（与 text 二选一；推荐，更像真人）',
          items: { type: 'string' },
        },
        contextToken: { type: 'string', description: '可选：显式指定该会话最近的 context_token' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { chunks: { type: 'number', description: '实际发送的段数' } },
        required: ['chunks'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlocks(`已发送到微信（${value?.chunks ?? 1} 段）`),
    },
    async execute(args) {
      const result = await sendToUser({
        to: args.to,
        text: args.text,
        messages: args.messages,
        contextToken: args.contextToken,
      })
      return { chunks: result.chunks }
    },
  })

  // 「给微信发图片」——主动推送表情包/生成的图。
  tools.push({
    name: 'wechat_send_image',
    description:
      '主动给微信用户推送一张**本地图片**（不需要等对方先发消息），'
      + '比如表情包、生成的图。`imagePath` 填本地图片的绝对路径；'
      + '`caption` 可选，作为配文（会单独占一条消息，先图后文顺序为图→文由官方协议决定）。'
      + 'context_token 插件自动回带，消息落回原来的聊天窗口。'
      + '注意微信侧限制：只接收 24 小时内的回复。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '微信用户的 ilink id，形如 xxx@im.wechat' },
        imagePath: { type: 'string', description: '本地图片的绝对路径（jpg/png/gif/webp）' },
        caption: { type: 'string', description: '可选：随图配的一句话' },
        contextToken: { type: 'string', description: '可选：显式指定该会话最近的 context_token' },
      },
      required: ['to', 'imagePath'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'string', description: '服务端返回的消息 id' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlocks(
        value?.ok ? `图片已推送到微信（message_id: ${value.messageId || '未知'}）` : '推送失败',
      ),
    },
    async execute(args) {
      return sendImageToUser({
        to: args.to,
        imagePath: args.imagePath,
        caption: args.caption,
        contextToken: args.contextToken,
      })
    },
  })

  // 状态文件里记录的微信联系人，方便 agent 决定推给谁。
  tools.push({
    name: 'wechat_list_contacts',
    description:
      '列出已知的微信联系人，以及每个联系人绑定到哪个 DSH 会话。'
      + '在需要主动推送微信消息、或想知道当前有哪些微信连进来时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          contacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                userId: { type: 'string' },
                sessionId: { type: 'string' },
                bound: { type: 'boolean' },
              },
              required: ['userId', 'sessionId', 'bound'],
              additionalProperties: false,
            },
          },
        },
        required: ['contacts'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlocks(`已知微信联系人 ${value?.contacts?.length ?? 0} 个`),
    },
    async execute() {
      const map = new Map()
      for (const [userId, row] of Object.entries(state.bindings)) {
        map.set(userId, { userId, sessionId: row.sessionId, bound: true })
      }
      for (const [userId, row] of Object.entries(state.sessions)) {
        if (!map.has(userId)) {
          map.set(userId, { userId, sessionId: row.sessionId, bound: false })
        }
      }
      return { contacts: [...map.values()] }
    },
  })

  if (config.enableTools !== false) {
    ctx.effect(() => {
      const disposers = tools.map((definition) => ctx.tools.register(definition))
      return () => {
        for (const dispose of disposers) dispose?.()
      }
    }, `${name}.tools()`)
  }

  // ── 设置页路由 ──────────────────────────────────────────────────────────
  const disposers = []
  const route = (handler, { allowGet = false } = {}) =>
    async (req, res) => {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: '请求来源不受信任' })
        return
      }
      if (!allowGet && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '请使用 POST' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    }

  /**
   * 拿一个会话的可读名称。优先级：
   *   1. workspace 注册表里的标题（DSH 侧边栏显示的名字）
   *   2. 绑定时用户写的备注 label
   *   3. 会话 id 本身（截短）
   * 全是展示用途，失败就退回下一级，绝不抛错。
   * @param {string} sessionId 会话 id。
   * @param {string} fallbackLabel 绑定备注。
   * @returns {Promise<string>}
   */
  const sessionDisplayName = async (sessionId, fallbackLabel = '') => {
    try {
      const registry = ctx.get('workspaceRegistry')
      const cwd = state.cwd || process.cwd()
      const workspace = await registry?.resolveByPath?.(cwd)
      const sessions = workspace?.sessions ?? workspace?.record?.sessions
      if (Array.isArray(sessions)) {
        const hit = sessions.find((s) => s?.id === sessionId || s?.sessionId === sessionId)
        const title = hit?.title ?? hit?.name ?? hit?.label
        if (typeof title === 'string' && title.trim()) return title.trim()
      }
    } catch {
      // 展示用途，吞掉。
    }
    if (fallbackLabel && fallbackLabel.trim()) return fallbackLabel.trim()
    return sessionId.length > 28 ? `${sessionId.slice(0, 25)}…` : sessionId
  }

  // ── 设置页（自包含 HTML，无外部依赖）────────────────────────────────────
  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/page`,
        handler: route(async (req, res) => {
          // 复用 status 的数据组装逻辑：绑定 + 联系人 + 登录态 + 统计。
          const bindings = []
          for (const [userId, row] of Object.entries(state.bindings)) {
            bindings.push({
              userId,
              sessionId: row.sessionId,
              label: row.label ?? '',
              boundAt: row.boundAt,
              live: Boolean(ctx.agents.get(row.sessionId)),
              name: await sessionDisplayName(row.sessionId, row.label ?? ''),
            })
          }
          const contacts = []
          for (const [userId, row] of Object.entries(state.sessions)) {
            if (state.bindings[userId]) continue
            contacts.push({
              userId,
              sessionId: row.sessionId,
              lastAt: row.lastAt,
              live: Boolean(ctx.agents.get(row.sessionId)),
            })
          }
          const data = {
            loggedIn: Boolean(runtime.token),
            monitoring: runtime.monitoring,
            accountId: runtime.accountId,
            needsRelogin: runtime.needsRelogin,
            lastError: runtime.lastError,
            stats: {
              inbound: runtime.inboundCount,
              outbound: runtime.outboundCount,
              imagesIn: runtime.imageInCount,
              imagesOut: runtime.imageOutCount,
            },
            bindings,
            contacts,
          }
          sendHtml(res, 200, renderSettingsPage(data, Boolean(req.headers.origin)))
        }, { allowGet: true }),
      },
      `${name}.page`,
    ),
  )

  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: route(async (_req, res) => {
          sendJson(res, 200, {
            ok: true,
            loggedIn: Boolean(runtime.token),
            accountId: runtime.accountId,
            userId: runtime.userId,
            baseUrl: runtime.baseUrl,
            monitoring: runtime.monitoring,
            cwd: state.cwd || process.cwd(),
            lastError: runtime.lastError,
            // token 失效时给前端一个明确信号：该重新扫码了。
            needsRelogin: runtime.needsRelogin,
            stats: {
              inbound: runtime.inboundCount,
              outbound: runtime.outboundCount,
              imagesIn: runtime.imageInCount,
              imagesOut: runtime.imageOutCount,
              lastInboundAt: runtime.lastInboundAt,
              lastOutboundAt: runtime.lastOutboundAt,
            },
            bindings: Object.entries(state.bindings).map(([userId, row]) => ({
              userId,
              sessionId: row.sessionId,
              label: row.label ?? '',
              boundAt: row.boundAt,
              live: Boolean(ctx.agents.get(row.sessionId)),
            })),
            contacts: Object.entries(state.sessions).map(([userId, row]) => ({
              userId,
              sessionId: row.sessionId,
              lastAt: row.lastAt,
              live: Boolean(ctx.agents.get(row.sessionId)),
            })),
            login: runtime.login
              ? {
                  status: runtime.login.status,
                  url: runtime.login.url,
                  startedAt: runtime.login.startedAt,
                  bindSessionId: runtime.login.bindSessionId,
                }
              : null,
          })
        }),
      },
      `${name}.status`,
    ),
  )

  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/login`,
        handler: route(async (req, res) => {
          const body = await readJsonBody(req)
          sendJson(res, 200, await startLogin({ bindSessionId: body.bindSessionId }))
        }),
      },
      `${name}.login`,
    ),
  )

  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/login/status`,
        handler: route(async (_req, res) => {
          sendJson(res, 200, await pollLogin())
        }),
      },
      `${name}.login-status`,
    ),
  )

  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/login/verify`,
        handler: route(async (req, res) => {
          const body = await readJsonBody(req)
          sendJson(res, 200, await submitVerifyCode(body.code))
        }),
      },
      `${name}.login-verify`,
    ),
  )

  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/logout`,
        handler: route(async (_req, res) => {
          sendJson(res, 200, await logout())
        }),
      },
      `${name}.logout`,
    ),
  )

  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/unbind`,
        handler: route(async (req, res) => {
          const body = await readJsonBody(req)
          const userId = String(body.userId ?? '')
          if (!userId || !state.bindings[userId]) {
            sendJson(res, 404, { ok: false, error: '没有这个绑定' })
            return
          }
          unbindSession(userId)
          sendJson(res, 200, { ok: true })
        }),
      },
      `${name}.unbind`,
    ),
  )

  // 直接把某个微信改绑到指定会话（不用重新扫码）。
  // 是「消息进错会话」这个坑的运维出口：绑定关系存在磁盘上，
  // 手工改文件会被运行中的实例内存状态覆盖，所以必须走这里。
  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/bind`,
        handler: route(async (req, res) => {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          const userId = String(body.userId ?? '')
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: '需要 sessionId' })
            return
          }
          // 不指定 userId 时，改绑所有已有绑定的联系人（通常只有一个）。
          const users = userId ? [userId] : Object.keys(state.bindings ?? {})
          if (users.length === 0) {
            sendJson(res, 404, { ok: false, error: '当前没有任何绑定可以改绑' })
            return
          }
          const changes = []
          for (const u of users) {
            const before = state.bindings[u]?.sessionId ?? null
            state.bindings[u] = {
              sessionId,
              boundAt: Date.now(),
              label: state.bindings[u]?.label ?? '',
            }
            changes.push({ userId: u, from: before, to: sessionId })
          }
          // 清掉陈旧待绑定，避免以后再误绑。
          state.pendingBinds = {}
          persist()
          logger.info?.(`微信 ClawBot: 改绑 ${users.length} 个联系人到会话 ${sessionId}`)
          sendJson(res, 200, { ok: true, changes })
        }),
      },
      `${name}.bind`,
    ),
  )

  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/settings`,
        handler: route(async (req, res) => {
          const body = await readJsonBody(req)
          if (typeof body.cwd === 'string') state.cwd = body.cwd.trim()
          persist()
          sendJson(res, 200, { ok: true, cwd: state.cwd || process.cwd() })
        }),
      },
      `${name}.settings`,
    ),
  )

  // 查询 / 切换某个会话的权限（设置页与微信指令共用同一套逻辑）。
  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/permission`,
        handler: route(async (req, res) => {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (!sessionId) {
            sendJson(res, 400, { ok: false, error: '需要 sessionId' })
            return
          }
          const agent = ctx.agents.get(sessionId)
          if (!agent) {
            sendJson(res, 404, {
              ok: false,
              error: '该会话当前不是 live 状态（先发一条消息把它唤醒）',
              presets: Object.keys(PERMISSION_PRESETS),
            })
            return
          }
          const preset = String(body.preset ?? '')
          if (!preset) {
            sendJson(res, 200, { ok: true, preset: null, presets: PERMISSION_PRESETS })
            return
          }
          const result = applyPermissionPreset(agent, preset)
          sendJson(res, result.ok ? 200 : 400, result)
        }),
      },
      `${name}.permission`,
    ),
  )

  // ── 待机设置（DSH 设置页用）────────────────────────────────────────────
  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/idle`,
        handler: route(async (_req, res) => {
          sendJson(res, 200, {
            ok: true,
            settings: idleState.settings,
            defaults: IDLE_DEFAULTS,
            idle: idleState.idle,
            schedules: idleState.schedules,
            // 给设置页展示「现在是哪个对话在等着」。
            bindingCount: Object.keys(state.bindings ?? {}).length,
            // 诊断：AI 到底有没有在调 wechat_idle / wechat_schedule。
            // 很多人会遇到「设置了但从不触发」——通常是模型压根没想起来调，
            // 这两个计数让原因一目了然。
            diagnostics: {
              idleToolCalls: runtime.idleToolCalls,
              scheduleToolCalls: runtime.scheduleToolCalls,
              autoArmed: runtime.autoArmedCount,
              idleTriggers: runtime.idleTriggerCount,
              lastTriggeredAt: runtime.lastIdleTriggerAt,
              silentChain: runtime.idleSilentChain,
              autoArmPaused: runtime.autoArmPaused,
            },
          })
        }, { allowGet: true }),
      },
      `${name}.idle`,
    ),
  )

  // 保存待机设置 / 取消当前心跳。
  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/idle/save`,
        handler: route(async (req, res) => {
          const body = await readJsonBody(req)
          const patch = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (body.defaultMinutes !== undefined) {
            patch.defaultMinutes = coerceMinutes(
              body.defaultMinutes,
              idleState.settings.defaultMinutes,
            )
          }
          if (typeof body.idleMessage === 'string' && body.idleMessage.trim() !== '') {
            patch.idleMessage = body.idleMessage.trim()
          }
          if (body.maxChain !== undefined) {
            const n = Number(body.maxChain)
            if (Number.isFinite(n) && n >= 0) patch.maxChain = Math.trunc(n)
          }
          if (typeof body.autoArm === 'boolean') patch.autoArm = body.autoArm
          if (body.silentLimit !== undefined) {
            const n = Number(body.silentLimit)
            if (Number.isFinite(n) && n >= 0) patch.silentLimit = Math.trunc(n)
          }
          idleState.settings = { ...idleState.settings, ...patch }
          // 关掉总开关时顺手取消已排的心跳，避免关完还弹提醒。
          if (patch.enabled === false && idleState.idle) idleState.idle = null
          // 动过设置就恢复自动兜底资格（用户显式表达意图了）。
          runtime.autoArmPaused = false
          runtime.idleSilentChain = 0
          persistIdle()
          scheduleIdleTick()
          sendJson(res, 200, { ok: true, settings: idleState.settings, idle: idleState.idle })
        }),
      },
      `${name}.idle-save`,
    ),
  )

  // 手动取消当前待机心跳（设置页按钮）。
  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/idle/cancel`,
        handler: route(async (_req, res) => {
          const was = Boolean(idleState.idle)
          if (was) {
            idleState.idle = null
            persistIdle()
            scheduleIdleTick()
          }
          sendJson(res, 200, { ok: true, cancelled: was })
        }),
      },
      `${name}.idle-cancel`,
    ),
  )

  // 立即触发一次当前待机（设置页「立刻试一下」按钮，也方便排障）：
  // 把 dueAt 拨到现在，下一次 tick 就会执行。
  disposers.push(
    ctx.webServer.register(
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/idle/trigger`,
        handler: route(async (_req, res) => {
          if (!idleState.idle) {
            sendJson(res, 404, { ok: false, error: '当前没有待机中的心跳' })
            return
          }
          idleState.idle.dueAt = Date.now()
          persistIdle()
          scheduleIdleTick()
          sendJson(res, 200, { ok: true, triggered: true })
        }),
      },
      `${name}.idle-trigger`,
    ),
  )

  // ── 生命周期 ────────────────────────────────────────────────────────────
  ctx.effect(() => {
    // 自动拒绝兜底：微信侧没人能点「同意」，任何需要审批的操作都直接拒绝，
    // 不让它挂在那里等电脑前的人。权限预设若已把策略设成 never，
    // DSH 根本不会走到 answerer，两者互为冗余。
    const offAnswerer = installAutoDenyAnswerer()
    if (runtime.token && state.enabled) {
      queueMicrotask(startMonitor)
    }
    // 恢复待机 / 定时任务：重启 DSH 后尚未到点的计划要继续生效，
    // 已经过期的直接丢弃（没必要补发一堆迟到的提醒）。
    const now = Date.now()
    let pruned = false
    const aliveSchedules = idleState.schedules.filter((s) => {
      if (s.dueAt <= now - 60 * 60_000) {
        // 过期超过 1 小时：静默丢弃。
        pruned = true
        return false
      }
      return true
    })
    if (aliveSchedules.length !== idleState.schedules.length) {
      idleState.schedules = aliveSchedules
    }
    if (idleState.idle && idleState.idle.dueAt <= now - 60 * 60_000) {
      idleState.idle = null
      pruned = true
    }
    if (pruned) persistIdle()
    if (idleState.idle || idleState.schedules.length > 0) {
      logger.info?.(
        `微信 ClawBot: 恢复 ${idleState.schedules.length} 个定时任务`
        + (idleState.idle ? '，1 个待机心跳' : ''),
      )
      scheduleIdleTick()
    }
    return () => {
      offAnswerer()
      runtime.abort?.abort()
      runtime.login?.abort?.abort()
      if (runtime.login?.timer) clearTimeout(runtime.login.timer)
      runtime.login = null
      if (runtime.idleTimer) {
        clearTimeout(runtime.idleTimer)
        runtime.idleTimer = null
      }
    }
  }, `${name}.lifecycle()`)

  logger.info?.(
    runtime.token
      ? `微信 ClawBot: 已有登录态（account=${runtime.accountId || '未知'}），开始监听`
      : '微信 ClawBot: 未登录。在对话里说「把这个对话绑定到微信」即可开始',
  )
}

/**
 * 从 DSH 附件存储里读出图片字节。
 * @param {object} ctx 宿主上下文。
 * @param {string} attachmentId 附件 id。
 * @returns {Promise<Buffer|null>}
 */
async function readAttachmentBytes(ctx, attachmentId) {
  const attachments = ctx.get('attachments')
  if (!attachments) return null

  // 不同后端提供的读法不完全一样，按可用性依次尝试。
  if (typeof attachments.readImageBytes === 'function') {
    const bytes = await attachments.readImageBytes({ attachmentId })
    return bytes ? Buffer.from(bytes) : null
  }
  const hostPath = attachments.imageHostPath?.({ attachmentId })
  if (hostPath) {
    try {
      return fs.readFileSync(hostPath)
    } catch {
      return null
    }
  }
  return null
}

/**
 * 用文件头嗅探图片格式。微信图片主要是 jpg，也有 png / webp / gif。
 * @param {Buffer} data 图片字节。
 * @returns {string|null} MIME 类型，认不出返回 null。
 */
function sniffImageType(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return null
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png'
  }
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export { name, inject, apply, sniffImageType, chunkText }
export default { name, inject, apply }
