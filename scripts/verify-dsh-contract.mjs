/**
 * scripts/verify-dsh-contract.mjs — 用**真实 DSH 依赖**验证插件遵守的契约。
 *
 * 这个脚本不测插件逻辑（那是 integration.mjs 的事），而是验证插件对 DSH
 * 的**假设**是否成立。它直接加载已安装的 DSH 包，因此能抓住
 * 「只在真实运行时才暴露」的问题。
 *
 * 当前覆盖：
 *   1. 消息 source.kind 必须是 producer-owned（不能是字面量 "plugin"）。
 *      —— 这是曾经真实踩过的坑：写入看似成功，读取会话时才报错。
 *
 * 用法：
 *   node scripts/verify-dsh-contract.mjs
 *   node scripts/verify-dsh-contract.mjs --dsh-root <path/to/dsh/node_modules>
 *
 * 找不到 DSH 依赖时**跳过**（退出码 0），这样在没有 DSH 的环境里
 * 也不会误报失败。
 */

import fs from 'node:fs'
import path from 'node:path'

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}

/** 候选的 DSH 依赖树位置。 */
const candidateRoots = [
  argOf('--dsh-root', ''),
  process.env.DSH_NODE_MODULES ?? '',
  'D:/DeepseekHarness/resources/app.asar.unpacked/dsh/node_modules',
  path.join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'node_modules'),
].filter(Boolean)

/**
 * 找到 dsh-session-format-v3-to-v4 的入口文件。
 * @returns {string|null}
 */
function findFormatPackage() {
  for (const root of candidateRoots) {
    const p = path.join(root, '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')
    if (fs.existsSync(p)) return p
  }
  return null
}

const entry = findFormatPackage()
if (!entry) {
  console.log('跳过：没有找到 DSH 的 session-format 包。')
  console.log('')
  console.log('  已尝试:')
  for (const r of candidateRoots) console.log(`    ${r}`)
  console.log('')
  console.log('  DSH 的包通常打包在 app.asar 里，磁盘上没有可直接 import 的副本。')
  console.log('  要跑这一项，先把 asar 解包，然后用 --dsh-root 指过去：')
  console.log('')
  console.log('    npx @electron/asar extract "D:/DeepseekHarness/resources/app.asar" ./app')
  console.log('    node scripts/verify-dsh-contract.mjs --dsh-root ./app/dsh/node_modules')
  console.log('')
  console.log('  （跳过不算失败：在没有 DSH 依赖的环境里这是正常的）')
  process.exit(0)
}

console.log('DSH 契约验证')
console.log(`  依赖: ${entry}`)
console.log('')

const mod = await import(`file:///${entry.replace(/\\/g, '/')}`)
const { assertReleasedV4Relationships } = mod

let passed = 0
let failed = 0

/**
 * 跑一个契约检查。
 * @param {string} label
 * @param {() => void} fn
 */
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

if (typeof assertReleasedV4Relationships !== 'function') {
  console.log('跳过：这个 DSH 版本没有导出 assertReleasedV4Relationships。')
  process.exit(0)
}

/** 真实已知事件类型（让校验器解释 user/message）。 */
const knownEventTypes = new Set(['user/message'])

/**
 * 用真实校验函数检查某条 user/message 的 source。
 * @param {object} source
 * @returns {{ok: boolean, error?: string}}
 */
function validateSource(source) {
  const artifact = {
    events: [
      {
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        data: {
          id: 'msg-contract-1',
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          source,
        },
        surfaceOp: 'append',
      },
    ],
    header: { id: 'contract-session', cwd: '/tmp' },
    inheritedEventCount: 0,
  }
  try {
    assertReleasedV4Relationships(artifact, knownEventTypes)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

console.log('消息 source.kind 契约：')

check('字面量 "plugin" 必须被拒绝（DSH 读取期校验）', () => {
  const r = validateSource({ kind: 'plugin', plugin: 'dsh-wechat-clawbot' })
  if (r.ok) {
    throw new Error('DSH 本应拒绝 { kind: "plugin" }，实际却放行了 —— 契约变了，需重新核对')
  }
})

check('插件实际使用的 "plugin:dsh-wechat-clawbot" 必须被接受（另一种合法写法）', () => {
  const r = validateSource({ kind: 'plugin:dsh-wechat-clawbot' })
  if (!r.ok) {
    throw new Error(`DSH 拒绝了 plugin:<包名> 这种 kind：${r.error}`)
  }
})

check('插件实际使用的 "user" 必须被接受', () => {
  // 插件最终采用 kind: "user"：既是合法 source（非字面量 plugin），
  // 又能让前端渲染成正常用户气泡。
  const r = validateSource({ kind: 'user', via: 'dsh-wechat-clawbot' })
  if (!r.ok) {
    throw new Error(`DSH 拒绝了 kind:"user"：${r.error}`)
  }
})

// 从插件源码里读出它实际用的 kind，避免「测试写的值」和「代码用的值」脱节。
const indexPath = path.join(import.meta.dirname, '..', 'lib', 'index.js')
const indexSource = fs.readFileSync(indexPath, 'utf8')

check('插件源码里的 source.kind 不是字面量 plugin', () => {
  if (/source:\s*\{\s*kind:\s*['"]plugin['"]/.test(indexSource)) {
    throw new Error('lib/index.js 里仍有 source: { kind: "plugin" }，会导致微信消息进不来')
  }
})

check('插件源码用的是 kind: "user"（前端才会显示成正常气泡）', () => {
  if (!/kind:\s*'user'/.test(indexSource)) {
    throw new Error("lib/index.js 里没找到 source.kind = 'user'")
  }
})

console.log('')
console.log(`结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
