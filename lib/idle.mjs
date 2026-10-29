/**
 * dsh-wechat-clawbot — 待机（idle heartbeat）与定时任务存储。
 *
 * 两个东西分开：
 *
 *   1. **待机心跳（idle）**：AI 回复完一条微信消息后，可以主动「定一个闹钟」：
 *      N 分钟后，插件模拟用户发一条 A 类消息（比如「过去 5 分钟了，没有任何消息」），
 *      让 AI 决定要不要主动说点什么、以及下一轮待机多久。
 *      —— 这是「AI 自己决定要不要找你」的机制，不是定时任务。
 *
 *   2. **定时任务（schedules）**：用户明确说「10 分钟后叫我」，插件登记一个一次性
 *      时序任务，到点发一条 A 类消息。这类任务**不受**待机开关影响，
 *      因为它来自用户的明确指令。
 *
 * 状态集中放在 `$DSH_HOME/dsh-wechat-clawbot/idle.json`，与 state.json 分开：
 * state.json 里是登录/绑定这类敏感数据（0600），而待机偏好变化频繁，
 * 混在一起会让每次心跳都重写一份含 token 的文件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认待机分钟数（AI 没指定时用）。 */
export const DEFAULT_IDLE_MINUTES = 5

/** 允许的待机区间（分钟）：太短会刷屏，太长等于关掉。 */
export const MIN_IDLE_MINUTES = 1
export const MAX_IDLE_MINUTES = 24 * 60

/** 设置项默认值（也是 schema 真源）。 */
export const IDLE_DEFAULTS = {
  /** 全局总开关：关掉之后 AI 的待机请求一律不生效。 */
  enabled: true,
  /** 默认待机时长（分钟），AI 未指定时使用。 */
  defaultMinutes: DEFAULT_IDLE_MINUTES,
  /** A 类消息的文本模板。`{minutes}` 会被替换成实际分钟数。 */
  idleMessage: '过去 {minutes} 分钟了，没有任何消息',
  /**
   * 连续触发多少次待机后强制停一轮（防止两个 AI 互相「你还在吗」无限循环）。
   * 0 表示不限制。
   */
  maxChain: 12,
  /**
   * 自动待机：AI 回复完微信消息后，如果它自己没调 `wechat_idle`，
   * 插件按默认时长替它登记一次。
   *
   * 为什么要这个：`wechat_idle` 是「主动性」工具，模型没有硬性理由时
   * 经常想不起来调（实测 37 轮微信对话里 0 次调用）。自动兜底让功能
   * 「默认生效」，AI 想关掉/改时长时再显式调用即可。
   *
   * 默认开启；不想被打扰就关掉它。
   */
  autoArm: true,
  /**
   * 连续多少次「被叫醒但什么都没说」之后暂停自动兜底。
   *
   * 为什么需要：待机只是**提醒**，AI 有权保持沉默。但如果它每次都沉默，
   * 自动兜底就会每 N 分钟白叫醒它一次——烧 token、写无意义的会话记录。
   * 达到次数就暂停兜底；AI 自己调 `wechat_idle` 仍然有效，
   * 用户发来真实消息会重置计数。0 表示不限制。
   */
  silentLimit: 2,
  /**
   * 主动推送配额：一个窗口内最多允许发多少条「主动消息」（每条逻辑消息算 1，
   * 分块不算）。
   *
   * 为什么需要：iLink 的 `sendmessage` 对 bot 有**突发限流**——
   * 短窗口内发约 5~6 条独立消息后就返回 `ret=-2 prepare failed`，
   * 而且处罚期内的每次发送尝试都会加重处罚。
   * 主动推送（待机提醒 / 定时任务 / 生图配文）是最容易踩线的路径，
   * 所以单独做预算：超了就快速失败，而不是继续把惩罚拖长。
   *
   * 0 表示不限制（不推荐）。
   */
  pushLimit: 4,
  /** 主动推送配额的滑动窗口（分钟）。默认 60。 */
  pushWindowMinutes: 60,
}

/** DSH 家目录。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 插件数据目录。 */
function dataDir(pluginName = 'dsh-wechat-clawbot') {
  return path.join(dshHome(), pluginName)
}

/**
 * 文件路径。
 * @param {string} pluginName 插件包名。
 * @returns {string}
 */
export function idleFile(pluginName) {
  return path.join(dataDir(pluginName), 'idle.json')
}

/**
 * 收敛分钟数到合法区间；非法值退回默认。
 * @param {unknown} value 候选值。
 * @param {number} fallback 默认值。
 * @returns {number}
 */
export function coerceMinutes(value, fallback = DEFAULT_IDLE_MINUTES) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, Math.round(n)))
}

/**
 * 读取待机设置与任务；任何异常都退回默认值。
 * @param {string} pluginName 插件包名。
 * @returns {{settings: object, schedules: object[], idle: object|null}}
 */
export function readIdleState(pluginName = 'dsh-wechat-clawbot') {
  const empty = { settings: { ...IDLE_DEFAULTS }, schedules: [], idle: null }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(idleFile(pluginName), 'utf8'))
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object') return empty

  const src = parsed.settings ?? {}
  const settings = {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : IDLE_DEFAULTS.enabled,
    defaultMinutes: coerceMinutes(src.defaultMinutes, IDLE_DEFAULTS.defaultMinutes),
    idleMessage:
      typeof src.idleMessage === 'string' && src.idleMessage.trim() !== ''
        ? src.idleMessage.trim()
        : IDLE_DEFAULTS.idleMessage,
    maxChain:
      Number.isFinite(Number(src.maxChain)) && Number(src.maxChain) >= 0
        ? Math.trunc(Number(src.maxChain))
        : IDLE_DEFAULTS.maxChain,
    autoArm: typeof src.autoArm === 'boolean' ? src.autoArm : IDLE_DEFAULTS.autoArm,
    silentLimit:
      Number.isFinite(Number(src.silentLimit)) && Number(src.silentLimit) >= 0
        ? Math.trunc(Number(src.silentLimit))
        : IDLE_DEFAULTS.silentLimit,
    pushLimit:
      Number.isFinite(Number(src.pushLimit)) && Number(src.pushLimit) >= 0
        ? Math.trunc(Number(src.pushLimit))
        : IDLE_DEFAULTS.pushLimit,
    pushWindowMinutes:
      Number.isFinite(Number(src.pushWindowMinutes)) && Number(src.pushWindowMinutes) > 0
        ? Math.trunc(Number(src.pushWindowMinutes))
        : IDLE_DEFAULTS.pushWindowMinutes,
  }

  const schedules = Array.isArray(parsed.schedules)
    ? parsed.schedules
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        id: String(s.id ?? ''),
        userId: String(s.userId ?? ''),
        sessionId: String(s.sessionId ?? ''),
        message: typeof s.message === 'string' ? s.message : '',
        dueAt: Number(s.dueAt ?? 0),
        createdAt: Number(s.createdAt ?? 0),
      }))
      .filter((s) => s.id !== '' && s.dueAt > 0)
    : []

  const idle = parsed.idle && typeof parsed.idle === 'object'
    ? {
        userId: String(parsed.idle.userId ?? ''),
        sessionId: String(parsed.idle.sessionId ?? ''),
        dueAt: Number(parsed.idle.dueAt ?? 0),
        minutes: Number(parsed.idle.minutes ?? 0),
        chain: Number(parsed.idle.chain ?? 0),
        armedAt: Number(parsed.idle.armedAt ?? 0),
      }
    : null

  return { settings, schedules, idle: idle && idle.dueAt > 0 ? idle : null }
}

/**
 * 原子写入待机状态。
 * @param {object} next `{settings, schedules, idle}`。
 * @param {string} pluginName 插件包名。
 * @returns {object} 写入后的状态。
 */
export function writeIdleState(next, pluginName = 'dsh-wechat-clawbot') {
  const dir = dataDir(pluginName)
  fs.mkdirSync(dir, { recursive: true })
  const file = idleFile(pluginName)
  const tmp = `${file}.${process.pid}.tmp`
  const payload = {
    settings: { ...IDLE_DEFAULTS, ...(next.settings ?? {}) },
    schedules: Array.isArray(next.schedules) ? next.schedules : [],
    idle: next.idle ?? null,
  }
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  return payload
}

/**
 * 把 `{minutes}` 占位符替换成实际分钟数。
 * @param {string} template 模板。
 * @param {number} minutes 分钟数。
 * @returns {string}
 */
export function renderIdleMessage(template, minutes) {
  const text = typeof template === 'string' && template.trim() !== ''
    ? template
    : IDLE_DEFAULTS.idleMessage
  return text.replaceAll('{minutes}', String(minutes))
}
