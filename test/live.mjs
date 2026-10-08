/**
 * 真机联通测试：**需要 DSH 之外的环境，且会真的拉起一个 AstrBot 进程**。
 *
 * 运行：npm run live
 *   （= node --import ./test/stub/register.mjs test/live.mjs）
 *
 * 与 smoke.mjs 的分工：
 *   smoke.mjs —— 纯离线，不需要 AstrBot，也不联网。
 *   live.mjs  —— 起一个**隔离的** AstrBot 实例（自带数据根、独立端口、关掉所有平台），
 *                跑通「启动 → 就绪 → 列插件 → 注入消息 → 收回复 → 停止」全链路。
 *
 * 注意：这里用 node:child_process 实现了一个 subprocess 服务的最小替身，
 * 只为在 DSH 之外验证插件逻辑；DSH 里跑的是真正的受管 subprocess 服务。
 */
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_ROOT = process.env.ASTRBOT_LIVE_ROOT || 'C:\\Users\\REISEN\\.astrbot-test'
const PORT = Number(process.env.ASTRBOT_LIVE_PORT || 6186)
const CLEAN = process.argv.includes('--clean')

// ── subprocess 服务替身（契约同 @deepseek-ai/dsh-subprocess） ─────────────
function makeSubprocess() {
  return {
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const bufs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      child.stdout.on('data', (d) => { bufs.stdout = Buffer.concat([bufs.stdout, d]) })
      child.stderr.on('data', (d) => { bufs.stderr = Buffer.concat([bufs.stderr, d]) })
      const done = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const reader = (which) => ({
        readFrom(offset) {
          const all = bufs[which]
          const from = Number.isFinite(offset) ? offset : 0
          return { text: all.subarray(from).toString('utf8'), nextOffset: all.length, lossy: false }
        },
      })
      return {
        stdin: null,
        stdout: null,
        stderr: null,
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        done,
        terminate() { try { child.kill() } catch {} },
        waitForExit() { return done.then(() => true) },
      }
    },
  }
}

function makeCtx() {
  const registered = []
  const disposers = []
  return {
    registered,
    ctx: {
      logger: { warn: (m) => console.log('  [warn]', String(m).slice(0, 200)), info() {}, error() {}, debug() {} },
      effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      inject() { return () => {} },
      systemPrompt: { section() { return () => {} } },
      subprocess: makeSubprocess(),
      tools: { register(d) { registered.push(d); return () => {} } },
      fiber: null,
    },
    disposers,
  }
}

const mod = await import('../lib/index.js')
const h = makeCtx()
mod.apply(h.ctx, mod.Config({}))
const T = (n) => {
  const d = h.registered.find((x) => x.name === n)
  assert.ok(d, `工具 ${n} 未注册`)
  return d
}

let failures = 0
async function step(name, fn) {
  process.stdout.write(`\n▸ ${name}\n`)
  try {
    await fn()
    console.log('  ✓ ok')
  } catch (err) {
    failures++
    console.log('  ✗ FAILED')
    console.log(String((err && err.stack) || err).split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'))
  }
}

console.log(`\nAstrBot 真机联通测试 — root=${TEST_ROOT} port=${PORT}`)
console.log(`清理测试根：${CLEAN ? '是' : '否（加 --clean 重来一次）'}`)

if (CLEAN) {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
}
mkdirSync(TEST_ROOT, { recursive: true })

// ── 1. 桌面安装探测 ──────────────────────────────────────────────────────
await step('astrbot_status 能定位桌面安装', async () => {
  const r = await T('astrbot_status').execute({}, {})
  assert.ok(!r.desktop_install_not_found, `未找到安装：tried=${JSON.stringify(r.tried)}`)
  console.log(`    安装根：${r.desktop_install.install}`)
  console.log(`    数据根：${r.desktop_install.data_root}`)
  console.log(`    版本：core ${r.desktop_install.core_version} / desktop ${r.desktop_install.desktop_version}`)
  console.log(`    桌面实例在跑：${r.desktop_instance_running}（PID ${r.desktop_heartbeat && r.desktop_heartbeat.pid}）`)
})

// ── 2. 启动隔离实例 ──────────────────────────────────────────────────────
await step(`astrbot_start 拉起隔离实例（${PORT}）`, async () => {
  const r = await T('astrbot_start').execute({ root: TEST_ROOT, port: PORT, wait_ms: 180000 }, {})
  if (!r.success) {
    console.log('    ' + JSON.stringify(r, null, 2).slice(0, 3000))
  }
  assert.equal(r.success, true, '实例未就绪')
  console.log(`    root=${r.root} port=${r.port} external=${r.external} pid=${r.pid || 'n/a'}`)
  console.log(`    就绪耗时：${r.ready_ms === undefined ? 'n/a' : r.ready_ms + ' ms'}`)
  if (r.stdout_tail) console.log('    stdout 尾部：\n      ' + String(r.stdout_tail).split('\n').slice(-6).join('\n      '))
})

// ── 3. 隔离实例自检 ──────────────────────────────────────────────────────
await step('astrbot_status 指向隔离实例', async () => {
  const r = await T('astrbot_status').execute({ root: TEST_ROOT }, {})
  assert.equal(r.target.reachable, true, `不可达：${JSON.stringify(r.target)}`)
  assert.equal(r.target.jwt_available, true, 'jwt_secret 不可读')
  console.log(`    目标：${r.target.base_url}（source=${r.target.source}）`)
})

await step('astrbot_plugins list 走通鉴权', async () => {
  const r = await T('astrbot_plugins').execute({ root: TEST_ROOT, action: 'list' }, {})
  assert.equal(r.ok, true, `HTTP 失败：${JSON.stringify(r).slice(0, 400)}`)
  const list = (r.response && r.response.data) || []
  console.log(`    隔离实例已加载插件数：${Array.isArray(list) ? list.length : 'n/a'}`)
})

await step('astrbot_plugins failed 为空（无导入期异常）', async () => {
  const r = await T('astrbot_plugins').execute({ root: TEST_ROOT, action: 'failed' }, {})
  assert.equal(r.ok, true)
  const data = r.response && r.response.data
  const n = Array.isArray(data) ? data.length : Object.keys(data || {}).length
  console.log(`    失败插件数：${n}`)
  assert.equal(n, 0, `有插件加载失败：${JSON.stringify(data).slice(0, 600)}`)
})

await step('★astrbot_chat 注入消息并收到回复（端到端）', async () => {
  const r = await T('astrbot_chat').execute({ root: TEST_ROOT, message: '/help', timeout_ms: 90000 }, {})
  if (!r.success) console.log('    ' + JSON.stringify(r, null, 2).slice(0, 2000))
  assert.equal(r.success, true, `未收到回复：${r.error || ''}`)
  assert.ok(r.reply && r.reply.length > 0, '回复为空')
  console.log(`    ${r.duration_ms} ms / ${r.event_count} 个事件`)
  console.log('    回复首行：' + r.reply.split('\n')[0])
})

await step('astrbot_logs file 模式能读到隔离实例日志', async () => {
  const r = await T('astrbot_logs').execute({ root: TEST_ROOT, source: 'file', lines: 40 }, {})
  if (r.error) console.log('    ' + JSON.stringify(r, null, 2).slice(0, 1200))
  else console.log(`    ${r.path}（共 ${r.total_lines} 行，返回 ${r.returned} 行）`)
})

// ── 4. 停机 ──────────────────────────────────────────────────────────────
await step('astrbot_stop 停掉受管实例', async () => {
  const r = await T('astrbot_stop').execute({}, {})
  console.log('    ' + JSON.stringify(r).slice(0, 400))
  assert.ok(!r.error, `停止失败：${r.error}`)
})

await step('停机后端口不再应答', async () => {
  const r = await T('astrbot_status').execute({ root: TEST_ROOT }, {})
  console.log(`    reachable=${r.target.reachable}`)
  assert.equal(r.target.reachable, false, '端口仍在应答')
})

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 个步骤失败'}`)
console.log(`隔离测试根保留在 ${TEST_ROOT}（下次启动会直接复用；要重来加 --clean）`)

// 清掉可能残留的受管进程
for (const d of h.disposers) {
  try { d() } catch {}
}
process.exit(failures > 0 ? 1 : 0)
