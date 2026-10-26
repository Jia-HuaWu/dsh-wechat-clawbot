/**
 * scripts/_repair-session.mjs — 修复因缺 id/role 而被判 corrupt 的会话日志。
 *
 * 事故背景：早期插件的 followup() 只传 content + source，缺少
 *   message.id 与 message.role。
 * 内存里写得进去、消息也发得出去，但落盘后读取时 dsh-session 会报
 *   session event at seq N lacks an identified message
 * 导致整个会话被判为 corrupt，历史加载失败。
 *
 * ⚠️ 关键：必须**保留原有的 zstd 帧划分**。
 * DSH 的会话文件是「每次 flush 追加一帧」的流式格式（正常会话动辄上千帧）。
 * 如果把所有事件压成单帧，DSH 的读取器就认不出这个会话 ——
 * 表现是「会话在侧边栏里消失了」。所以这里逐帧处理，
 * 只在坏事件所在的那一帧里改写它，其余帧的字节原样保留。
 *
 * 安全措施：
 *   · 默认只做 dry-run，必须显式 --apply 才写；
 *   · 写入前自动备份为 .bak-before-repair；
 *   · 修完用真实 dsh-session 重新加载校验。
 *
 * 用法：
 *   node scripts/_repair-session.mjs <session.v4.jsonl.zstd> [--apply] [--dsh-root <path>]
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/_repair-session.mjs <session.v4.jsonl.zstd> [--apply]')
  process.exit(1)
}
const apply = process.argv.includes('--apply')
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}
const dshRoot = argOf('--dsh-root', '')

const MAGIC = 0xfd2fb528

/**
 * 按魔数扫描出每一帧的字节区间。
 * @param {Buffer} buf
 * @returns {Array<{start: number, end: number}>}
 */
function scanFrames(buf) {
  const starts = []
  for (let o = 0; o + 4 <= buf.length; o += 1) {
    if (buf.readUInt32LE(o) === MAGIC) starts.push(o)
  }
  return starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? starts[i + 1] : buf.length,
  }))
}

const raw = fs.readFileSync(file)
const frames = scanFrames(raw)

// 逐帧解压，得到每帧的文本（可能含多行，每行一个事件）。
const frameTexts = []
for (const f of frames) {
  const slice = raw.subarray(f.start, f.end)
  try {
    frameTexts.push(zlib.zstdDecompressSync(slice).toString('utf8'))
  } catch (e) {
    console.error(`帧 ${f.start} 解压失败：${e.message}`)
    process.exit(1)
  }
}

const allLines = frameTexts.flatMap((t) => t.split('\n').filter((l) => l.trim()))
console.log(`文件: ${file}`)
console.log(`磁盘 ${raw.length} 字节，${frames.length} 帧，${allLines.length} 行`)
console.log('')

// 找出需要修的：user/message 缺 id 或 role。
const fixPlan = new Map() // 行号 → 修补后的对象
let repaired = 0
let lineNo = 0
for (let fi = 0; fi < frameTexts.length; fi += 1) {
  for (const line of frameTexts[fi].split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      lineNo += 1
      continue
    }
    if (ev.type === 'user/message') {
      const d = ev.data ?? {}
      const needsId = typeof d.id !== 'string' || d.id === ''
      const needsRole = d.role !== 'user'
      if (needsId || needsRole) {
        if (needsId) d.id = randomUUID()
        if (needsRole) d.role = 'user'
        ev.data = d
        fixPlan.set(lineNo, ev)
        repaired += 1
        console.log(`  修复 seq ${ev.seq}（帧 ${fi}，行 ${lineNo}）:`)
        if (needsId) console.log(`    + id   = ${d.id}`)
        if (needsRole) console.log(`    + role = user`)
      }
    }
    lineNo += 1
  }
}

console.log('')
if (repaired === 0) {
  console.log('没有需要修复的事件。')
  process.exit(0)
}
console.log(`共需修复 ${repaired} 条事件（保留 ${frames.length} 帧结构）。`)

if (!apply) {
  console.log('')
  console.log('（dry-run：未写入。加 --apply 才会真正修改）')
  process.exit(0)
}

// 备份
const backup = `${file}.bak-before-repair`
if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup)
  console.log(`已备份: ${backup}`)
}

// 重建：逐帧重新压缩，只有内容变化的帧才重新压。
// 这样帧数量、帧顺序、未改动帧的字节都保持原样 —— DSH 才认得出这个会话。
const outChunks = []
lineNo = 0
let changedFrames = 0
for (let fi = 0; fi < frameTexts.length; fi += 1) {
  const original = frameTexts[fi]
  const lines = original.split('\n')
  let frameChanged = false
  const rebuilt = lines.map((line) => {
    if (!line.trim()) return line
    const patched = fixPlan.get(lineNo)
    lineNo += 1
    if (patched === undefined) return line
    frameChanged = true
    return JSON.stringify(patched)
  })
  if (frameChanged) {
    changedFrames += 1
    const text = rebuilt.join('\n')
    outChunks.push(zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
  } else {
    // 未改动的帧原样写回，保证字节一致。
    outChunks.push(raw.subarray(frames[fi].start, frames[fi].end))
  }
}

const out = Buffer.concat(outChunks)
fs.writeFileSync(file, out)
console.log(
  `已写入：${out.length} 字节（原 ${raw.length}），`
  + `${frames.length} 帧（其中 ${changedFrames} 帧被重写）`,
)

// 用真实 dsh-session 校验。
if (!dshRoot) {
  console.log('')
  console.log('（未传 --dsh-root，跳过真实校验）')
  process.exit(0)
}
const sessionEntry = path.join(dshRoot, '@deepseek-ai/dsh-session/lib/index.js')
if (!fs.existsSync(sessionEntry)) {
  console.log('')
  console.log(`（找不到 ${sessionEntry}，跳过真实校验）`)
  process.exit(0)
}

try {
  const mod = await import(`file:///${sessionEntry.replace(/\\/g, '/')}`)
  const { Session } = mod
  // 重新读盘，模拟真实加载路径。
  const again = fs.readFileSync(file)
  const texts = []
  for (const f of scanFrames(again)) {
    texts.push(zlib.zstdDecompressSync(again.subarray(f.start, f.end)).toString('utf8'))
  }
  const evs = texts.flatMap((t) => t.split('\n').filter((l) => l.trim())).map((l) => JSON.parse(l))
  // 第一行是 session 元数据（header），不是事件，不进 seed。
  const seed = evs.filter((e) => e.type !== 'session' && typeof e.seq === 'number')
  Session.create('repair-check', seed)
  console.log('')
  console.log(`✅ 真实 dsh-session 重新加载校验：通过（${seed.length} 条事件，${scanFrames(again).length} 帧）`)
} catch (e) {
  console.log('')
  console.log(`⚠️  真实校验未通过：${e?.message ?? e}`)
  console.log(`   备份在 ${backup}，可以还原。`)
  process.exit(1)
}
