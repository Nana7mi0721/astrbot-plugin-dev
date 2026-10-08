/**
 * 离线冒烟测试：不需要 DSH、不需要 AstrBot 在跑、不联网。
 *
 * 运行：npm test
 *   （= node --import ./test/stub/register.mjs test/smoke.mjs）
 *
 * 覆盖的真实风险点：
 *   ① 模块能否在缺 DSH 依赖时加载（用 test/stub 替身）
 *   ② apply() 是否注册出全部工具、名字是否唯一、结构是否合法
 *   ③ 配置解析三级回退（工具参数 / 设置文件 / 自动探测）是否真的生效
 *   ④ 自签 JWT 的签名与 payload 是否正确（用独立实现的 HMAC 对拍）
 *   ⑤ 目标不存在时工具是否**优雅降级**（返回 error 字段而不是抛异常）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 环境隔离：必须在 import 插件之前设好，插件懒读这两个变量 ──────────────
const TMP = mkdtempSync(join(tmpdir(), 'astrbot-bridge-'))
const DSH_HOME = join(TMP, 'dsh-home')
const FAKE_INSTALL = join(TMP, 'AstrBot')
const FAKE_ROOT = join(TMP, 'astrbot-data')
process.env.DSH_HOME = DSH_HOME
// 不要设 ASTRBOT_ROOT：那会改变插件对「默认测试根」的推断
delete process.env.ASTRBOT_ROOT

const SECRET = 'f'.repeat(64)
const ADMIN_USER = 'tester'

function writeFakeInstall() {
  // installShape() 要求 backend/python/python.exe 与 backend/launch_backend.py 同时存在
  for (const rel of ['backend/python', 'backend/app']) {
    mkdirSync(join(FAKE_INSTALL, rel), { recursive: true })
  }
  writeFileSync(join(FAKE_INSTALL, 'backend/python/python.exe'), 'stub')
  writeFileSync(join(FAKE_INSTALL, 'backend/launch_backend.py'), '# stub\n')
  writeFileSync(
    join(FAKE_INSTALL, 'backend/runtime-manifest.json'),
    JSON.stringify({ desktopVersion: '4.28.2', coreVersion: '4.28.2', python: 'python\\python.exe' }),
  )
}

function writeFakeDataRoot() {
  // cmd_config.json 是 UTF-8 **with BOM** —— 故意带 BOM，验证解析路径
  const cfg = {
    dashboard: { enable: true, host: '127.0.0.1', port: 6199, username: ADMIN_USER, jwt_secret: SECRET },
    platform: [{ enable: true, type: 'aiocqhttp' }],
    log_file_enable: false,
  }
  mkdirSync(join(FAKE_ROOT, 'data'), { recursive: true })
  writeFileSync(
    join(FAKE_ROOT, 'data/cmd_config.json'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(cfg, null, 2))]),
  )
}

writeFakeInstall()
writeFakeDataRoot()

// ── 极简测试框架 ─────────────────────────────────────────────────────────
const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (err) {
    results.push({ name, ok: false, err })
    console.log(`  ✗ ${name}`)
    console.log(`      ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n      ')}`)
  }
}

// ── 假 ctx（对应 cordis 的 fiber ctx 子集） ───────────────────────────────
function makeCtx() {
  const registered = []
  const sections = []
  const warnings = []
  const disposers = []
  const injections = []
  const ctx = {
    logger: {
      warn: (m) => warnings.push(String(m)),
      info: () => {},
      error: () => {},
      debug: () => {},
    },
    effect(fn) {
      const disposable = fn()
      if (typeof disposable === 'function') disposers.push(disposable)
      return disposable
    },
    // 可选服务（configEditor / settings）在离线环境里不存在。
    // cordis 的语义：inject 本身永远可用，但**依赖未满足时回调根本不会被调用**。
    // 所以这里只记录，不调用回调 —— 正好同时验证插件没有依赖可选服务才能工作。
    inject(names, fn) {
      injections.push(names)
      void fn
      return () => {}
    },
    systemPrompt: {
      section(s) {
        sections.push(s)
        return () => {}
      },
    },
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    fiber: null,
  }
  return { ctx, registered, sections, warnings, disposers, injections }
}

const mod = await import('../lib/index.js')

console.log('\ndsh-astrbot-plugin-dev — 离线冒烟\n')

// ── ① 导出形态 ──────────────────────────────────────────────────────────
await test('插件导出 name / inject / Config / apply', () => {
  assert.equal(typeof mod.name, 'string', 'name 必须是字符串')
  assert.ok(mod.name.length > 0, 'name 不能为空')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  for (const svc of ['subprocess', 'tools', 'systemPrompt']) {
    assert.ok(mod.inject.includes(svc), `inject 必须声明 ${svc}（cordis 4：未声明的服务属性访问即抛错）`)
  }
  assert.equal(typeof mod.apply, 'function', 'apply 必须是函数')
  assert.ok(mod.Config, '必须导出 Config')
})

// ── ② 工具注册 ──────────────────────────────────────────────────────────
const EXPECTED_TOOLS = [
  'astrbot_config',
  'astrbot_status',
  'astrbot_start',
  'astrbot_stop',
  'astrbot_token',
  'astrbot_api',
  'astrbot_plugins',
  'astrbot_reload',
  'astrbot_logs',
  'astrbot_chat',
  'astrbot_deploy',
  'astrbot_python',
]

let harness = null
await test('apply() 注册出全部 12 个工具，且结构合法', () => {
  harness = makeCtx()
  mod.apply(harness.ctx, mod.Config({}))
  const names = harness.registered.map((d) => d.name)
  assert.deepEqual(names.slice().sort(), EXPECTED_TOOLS.slice().sort(), '工具集合与预期不一致')
  assert.equal(new Set(names).size, names.length, '工具名重复')
  // 官方 @deepseek-ai/dsh-tools 的 value schema DSL 子集（runSchemaCompiler / ANNOTATION_KEYS）。
  // stub 版的 defineTool 是恒等函数，写错的 schema 在离线测试里不会被发现 —— 真机上会在
  // apply() 当场抛 JsonSchemaError（整个预设起不来）。所以这里做一次静态等价检查。
  const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])
  const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
  for (const def of harness.registered) {
    assert.ok(def.description && def.description.length > 20, `${def.name} 缺 description`)
    assert.equal(typeof def.execute, 'function', `${def.name} 缺 execute`)
    assert.ok(def.parameters && typeof def.parameters === 'object', `${def.name} 缺 parameters`)
    for (const [key, spec] of Object.entries(def.parameters)) {
      const at = `${def.name}.${key}`
      assert.ok(spec && typeof spec.type === 'string', `${at} 缺 type`)
      assert.ok(VALUE_TYPES.has(spec.type), `${at}.type=${spec.type} 不在官方子集内`)
      assert.ok(spec.description, `${at} 缺 description（工具 schema 要求）`)
      if (spec.type === 'object') {
        assert.equal(typeof spec.additionalProperties, 'boolean',
          `${at}：type:'object' 必须显式带 additionalProperties:true/false（否则官方 defineTool 抛 JsonSchemaError）；任意形状请用 type:'json'`)
      }
      if (spec.type === 'array') {
        assert.ok(spec.items && typeof spec.items === 'object', `${at}：type:'array' 必须带 items`)
      }
      for (const k of Object.keys(spec)) {
        assert.ok(
          k === 'type' || k === 'required' || k === 'enum' || k === 'const' || k === 'items' ||
          k === 'properties' || k === 'additionalProperties' || ANNOTATION_KEYS.has(k),
          `${at} 用了官方不认的键：${k}`
        )
      }
    }
    assert.ok(def.output && def.output.schema, `${def.name} 缺 output.schema`)
    assert.equal(def.output.schema.additionalProperties, true, `${def.name}.output.schema 必须是开放对象`)
    assert.equal(typeof def.output.render, 'function', `${def.name} 缺 output.render`)
  }
})

/** 按名字取工具定义。 */
function tool(name) {
  const def = harness.registered.find((d) => d.name === name)
  assert.ok(def, `工具 ${name} 未注册`)
  return def
}

/** 调用工具并把结果断言成「无损 JSON 对象」。 */
async function call(name, args = {}) {
  const out = await tool(name).execute(args, {})
  assert.equal(typeof out, 'object', `${name} 必须返回对象`)
  assert.notEqual(out, null, `${name} 返回 null`)
  // lossless JSON 契约：undefined / NaN / Infinity / -0 会被 tool runtime 拒收
  const seen = new Set()
  const walk = (o, path) => {
    if (o === null || typeof o !== 'object') return
    if (seen.has(o)) return
    seen.add(o)
    for (const [k, v] of Object.entries(o)) {
      assert.notEqual(v, undefined, `${name} 返回了 undefined 字段：${path}${k}`)
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v) && !Object.is(v, -0), `${name} 返回了非无损数字：${path}${k}`)
      } else if (typeof v === 'object') walk(v, `${path}${k}.`)
    }
  }
  walk(out, '')
  return out
}

// ── ③ 配置三级回退 ──────────────────────────────────────────────────────
await test('astrbot_config() 无参数 → 返回生效设置与探测结果', async () => {
  const r = await call('astrbot_config')
  assert.ok(r.settings && typeof r.settings === 'object', '缺 settings')
  assert.ok(r.probe && typeof r.probe === 'object', '缺 probe（自动探测结果）')
  assert.ok(typeof r.probe.test_root === 'string', 'probe 里应报告默认测试根')
  assert.equal(r.settings_file, join(DSH_HOME, 'astrbot-plugin-dev.json'), 'settings 落点不对')
})

await test('astrbot_config(desktop_root=...) 落盘到 $DSH_HOME/astrbot-plugin-dev.json', async () => {
  const r = await call('astrbot_config', { desktop_root: FAKE_INSTALL })
  assert.equal(r.success, true, `应报告成功：${JSON.stringify(r)}`)
  assert.ok(r.changed && r.changed.desktopRoot, 'changed 里应报告 desktopRoot')
  // 这条断言是为了守住一个真实踩过的坑：写设置的返回值里引用了块内声明的变量，
  // 一改设置就 ReferenceError。工具层会把它吞成 { error } —— 必须显式断言没有 error。
  assert.ok(!r.error, `不应有 error：${r.error}`)
  const saved = JSON.parse(
    (await import('node:fs')).readFileSync(join(DSH_HOME, 'astrbot-plugin-dev.json'), 'utf8'),
  )
  assert.equal(saved.desktopRoot, FAKE_INSTALL, '设置文件里的 desktopRoot 不对')
})

await test('设置文件生效 → astrbot_status 找到安装根', async () => {
  const r = await call('astrbot_status', {})
  assert.ok(!r.desktop_install_not_found, `应找到 AstrBot 安装，tried=${JSON.stringify(r.tried)}`)
  assert.equal(r.desktop_install.install, FAKE_INSTALL, '安装根不是 fixture')
  assert.equal(r.desktop_install.python, join(FAKE_INSTALL, 'backend/python/python.exe'), '解释器路径不对')
  assert.equal(typeof r.target, 'object', '应报告实例目标')
  assert.equal(typeof r.target.reachable, 'boolean', 'reachable 必须是布尔')
})

await test('volatile 字段以 { get() } 形态给出时也能读（DSH ≥ 0.2 形态）', async () => {
  const h = makeCtx()
  const cfg = mod.Config({})
  // 模拟 DSH 运行时把 .volatile() 字段冻结成引用
  cfg.desktopRoot = { get: () => FAKE_INSTALL }
  cfg.pythonPath = { get: () => '' }
  mod.apply(h.ctx, cfg)
  const status = h.registered.find((d) => d.name === 'astrbot_status')
  assert.ok(status, '工具未注册')
  const r = await status.execute({}, {})
  assert.ok(!r.desktop_install_not_found, 'volatile { get() } 形态下也应能找到安装根')
  assert.equal(r.desktop_install.install, FAKE_INSTALL)
})

// ── ④ 自签 JWT（独立实现对拍） ──────────────────────────────────────────
await test('astrbot_token 的签名可用独立 HMAC 复现，payload.username 正确', async () => {
  const r = await call('astrbot_token', { root: FAKE_ROOT })
  assert.equal(r.success, true, `应成功签发：${JSON.stringify(r)}`)
  const [h, p, sig] = r.token.split('.')
  assert.ok(h && p && sig, 'token 不是三段式')

  const expected = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
  assert.equal(sig, expected, '签名与独立计算的 HMAC-SHA256 不一致')

  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'))
  assert.equal(header.alg, 'HS256', 'alg 必须是 HS256')

  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
  assert.equal(payload.username, ADMIN_USER, 'payload.username 必须取自 cmd_config.json')
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'exp 必须在未来')

  assert.ok(String(r.usage.websocket).includes('/api/v1/unified-chat/ws?token='), 'usage 里应给出 WS 地址')
})

await test('cmd_config.json 的 BOM 被正确剥离', async () => {
  // 上一个测试已经间接证明：带 BOM 的文件被 parse 成功且 secret 正确
  const r = await call('astrbot_token', { root: FAKE_ROOT })
  assert.equal(r.success, true)
})

// ── ⑤ 优雅降级（不抛异常） ──────────────────────────────────────────────
await test('目标目录没有 cmd_config.json → 返回 error 而不是抛异常', async () => {
  const empty = join(TMP, 'no-config-here')
  mkdirSync(empty, { recursive: true })
  const r = await call('astrbot_token', { root: empty })
  assert.ok(r.error, '应返回 error 字段')
  assert.ok(String(r.error).length > 0)
})

await test('端口上没有任何实例 → astrbot_plugins 返回错误而不是抛异常', async () => {
  const r = await call('astrbot_plugins', { root: FAKE_ROOT, action: 'list' })
  assert.ok(r.error || r.failed !== undefined, `应优雅报告连不上：${JSON.stringify(r).slice(0, 200)}`)
})

await test('astrbot_deploy(dry_run) 不落盘且能报告源目录', async () => {
  const src = join(TMP, 'fake-plugin')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'main.py'), '# fake\n')
  writeFileSync(join(src, 'metadata.yaml'), 'name: fake\n')
  const r = await call('astrbot_deploy', { source: src, root: FAKE_ROOT, dry_run: true, reload: false })
  assert.ok(r.dry_run === true || r.dryRun === true || r.planned, `dry_run 应只报告计划：${JSON.stringify(r).slice(0, 200)}`)
})

await test('卸载时能清理（ctx.effect 的 disposer 已登记）', () => {
  assert.ok(harness.disposers.length >= 1, '至少有工具注册与进程清理的 disposer')
  for (const d of harness.disposers) {
    assert.equal(typeof d, 'function', 'disposer 必须是函数')
    d() // 不应抛异常
  }
})

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log(`失败：${failed.map((f) => f.name).join(' / ')}`)
}

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {}

process.exit(failed.length > 0 ? 1 : 0)
