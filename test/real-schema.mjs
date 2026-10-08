/**
 * 真·schema 校验：用**官方** @deepseek-ai/dsh-tools 的 defineTool 过一遍全部工具定义。
 *
 * 为什么必须单独有这个测试：`test/stub/dsh-tools.mjs` 里的 defineTool 是恒等函数，
 * 写错的 value schema 在离线冒烟里完全看不出来 —— 但在真机上 apply() 会当场抛
 * JsonSchemaError，整个预设起不来。真实事故：`body: { type: 'object' }` 少了
 * `additionalProperties` → `parameters.body.additionalProperties must be explicitly true or false`。
 *
 * 运行前提：官方包被打进 Electron 的 app.asar，普通 node 读不到 asar，所以本脚本会
 * 用 `ELECTRON_RUN_AS_NODE=1 <DeepSeek Harness.exe>` 把自己重启一遍。找不到 DSH 安装时
 * 打印 SKIP 并以 0 退出（CI 友好）。
 *
 *   node test/real-schema.mjs                      # 自动找安装
 *   DSH_INSTALL_ROOT=... node test/real-schema.mjs # 指定安装根（含 DeepSeek Harness.exe）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { register, createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const INSTALL_CANDIDATES = [
  process.env.DSH_INSTALL_ROOT || '',
  'D:\\Program\\deepseek harness desktop',
  'C:\\Program Files\\DeepSeek Harness',
  join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness'),
  join(process.env.LOCALAPPDATA || '', 'DeepSeek Harness'),
  '/Applications/DeepSeek Harness.app/Contents/MacOS',
].filter(Boolean)

/** 该安装根是否像一个可用的桌面安装（asar 是文件，普通 node 看不到里面，只看外壳）。 */
function looksInstalled(root) {
  return existsSync(join(root, 'resources', 'app.asar')) &&
    (existsSync(join(root, 'DeepSeek Harness.exe')) || existsSync(join(root, 'DeepSeek Harness')))
}

function exePath(root) {
  return existsSync(join(root, 'DeepSeek Harness.exe'))
    ? join(root, 'DeepSeek Harness.exe')
    : join(root, 'DeepSeek Harness')
}

if (process.env.DSH_REAL_SCHEMA_CHILD !== '1') {
  const root = INSTALL_CANDIDATES.find(looksInstalled)
  if (!root) {
    console.log('[verify:schema] SKIP：没找到 DeepSeek Harness 桌面安装（可用 DSH_INSTALL_ROOT 指定）')
    process.exit(0)
  }
  const child = spawnSync(exePath(root), ['--expose-internals', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_REAL_SCHEMA_CHILD: '1',
      DSH_INSTALL_ROOT: root,
    },
  })
  process.exit(child.status === null ? 1 : child.status)
}

// ── 子进程（Electron-as-node，可读 asar）────────────────────────────────────
const ASAR_DROP = join(process.env.DSH_INSTALL_ROOT, 'resources', 'app.asar', 'dsh')
const asarRequire = createRequire(join(ASAR_DROP, 'node_modules') + '\\')
const profileRequire = createRequire(
  join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'profiles', 'desktop', 'node_modules') + '\\'
)

/** @deepseek-ai/schemastery：asar 里优先，其次已装 profile 的 node_modules。 */
function resolveSchemastery() {
  for (const req of [asarRequire, profileRequire]) {
    try { return req.resolve('@deepseek-ai/schemastery') } catch { /* 继续找 */ }
  }
  throw new Error('找不到 @deepseek-ai/schemastery（asar 与 profile 里都没有）')
}

const SPECIFIERS = {
  '@deepseek-ai/dsh-tools': asarRequire.resolve('@deepseek-ai/dsh-tools'),
  '@deepseek-ai/schemastery': resolveSchemastery(),
}

// lib/index.js 是 ESM，裸包名要从 asar/profile 解析 —— 注册一个只认这两个名字的 resolve 钩子。
// 钩子模块用 data: URL 承载，避免往仓库里落临时文件。
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `import { createRequire } from 'node:module';\n` +
        `import { pathToFileURL } from 'node:url';\n` +
        `const MAP = ${JSON.stringify(
          Object.fromEntries(Object.entries(SPECIFIERS).map(([k, v]) => [k, pathToFileURL(v).href]))
        )};\n` +
        `export async function resolve(spec, ctx, next) {\n` +
        `  return MAP[spec] ? { url: MAP[spec], shortCircuit: true } : next(spec, ctx);\n` +
        `}\n`
    )
)

const defineTool = (await import(pathToFileURL(SPECIFIERS['@deepseek-ai/dsh-tools']).href)).defineTool
if (typeof defineTool !== 'function') throw new Error('asar 里的 dsh-tools 没有导出 defineTool')
console.log('[verify:schema] 官方 defineTool 已加载（来自 app.asar）')

let failed = 0
const fail = (msg) => { failed++; console.log('  FAIL ' + msg) }

// 用假 ctx 跑 apply()，注册表换成收集器（**不** stub dsh-tools —— 这就是本测试的意义）
const registered = []
const disposers = []
const noop = () => {}
const ctx = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  effect(fn) { const d = fn(); disposers.push(typeof d === 'function' ? d : noop); return () => {} },
  inject() { return () => {} },          // cordis 语义：依赖不可用时回调不执行
  get() { return undefined },
  tools: { register(def) { registered.push(def); return noop } },
  systemPrompt: { section() { return noop } },
  fs: {},
  sandboxPolicy: {},
}

const plugin = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)
await plugin.apply(ctx, plugin.Config({}))
console.log(`[verify:schema] apply() 通过，注册了 ${registered.length} 个工具`)
if (registered.length !== 12) fail(`工具数应为 12，实际 ${registered.length}`)

for (const def of registered) {
  const schema = def.parameters
  const okShape = def && typeof def.name === 'string' && typeof def.execute === 'function' &&
    schema && schema.type === 'object' && schema.properties && def.output && def.output.schema
  if (!okShape) { fail(`${def && def.name} 编译产物形状不对`); continue }
  console.log(`  ok ${def.name.padEnd(18)} props=${Object.keys(schema.properties).length} required=[${(schema.required || []).join(',')}]`)
}

// 必填校验必须由官方 validate 拦在 userExecute 之前（只对 required 非空的工具做，保证不会真的执行）
for (const def of registered) {
  if (!def.parameters.required || def.parameters.required.length === 0) continue
  try {
    await def.execute({}, {})
    fail(`${def.name}：空参数竟然放行了`)
  } catch (e) {
    const msg = `${e && e.name}: ${e && e.message}`
    if (!/ToolArgsError/.test(msg) || !/required/i.test(msg)) fail(`${def.name}：空参被拒但错误不对 -> ${msg}`)
    else console.log(`  ok ${def.name} 空参被官方 validate 拒绝`)
  }
}

// 顺带确认 lib/index.js 真的 import 了官方包（而不是某个替身）
const src = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')
if (!/from '@deepseek-ai\/dsh-tools'/.test(src)) fail('lib/index.js 没有从 @deepseek-ai/dsh-tools 导入')

console.log(failed ? `[verify:schema] FAILED (${failed})` : '[verify:schema] PASS：全部工具定义被官方 defineTool 接受')
process.exit(failed ? 1 : 0)
