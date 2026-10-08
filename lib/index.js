/**
 * dsh-astrbot-plugin-dev — DSH ↔ AstrBot 插件开发桥（标准 DSH 宿主插件形态）
 * ==========================================================================
 * 标准 DSH 插件：命名导出 name / inject / Config / apply，工具经官方
 * @deepseek-ai/dsh-tools 的 defineTool 构造，通过 ctx.tools.register 注册。
 *
 * 组合行（bundle 的 cordis.patch.yml 里写在 astrbot-plugin-dev 预设的
 * plugins 列表中，因此这些工具**只在该预设的会话里出现**）：
 *
 *   - id: astrbot-bridge
 *     name: dsh-astrbot-plugin-dev
 *     config: { desktopRoot: ..., defaultRoot: ..., defaultPort: 6186 }
 *
 * 为什么要这层桥：AstrBot 的插件开发闭环是「改代码 → 让框架重新 import →
 * 端到端发一条消息看着陆 → 看日志/失败列表」。手工做这件事要处理一堆本机
 * 细节：桌面版自带 CPython 运行时、数据根靠 ASTRBOT_ROOT 切换、dashboard
 * 端口与 jwt_secret、插件管理 API 有两套命名空间、就绪信号不是心跳文件、
 * WebChat 是内置常驻平台……本插件把这些固化成 12 个 astrbot_* 工具。
 *
 * 关键事实（全部来自本机 4.28.2 源码实证，详见 skills/astrbot-plugin-debug）：
 *   - 启动：`backend/python/python.exe backend/launch_backend.py --webui-dir <data>/dist`
 *     （必须走 launch_backend.py：它做 Windows DLL 预载与 certifi SSL 补丁）
 *   - 隔离：`ASTRBOT_ROOT` 是唯一隔离开关（`core/utils/astrbot_path.py:29-35`）；
 *     dashboard 端口用 `DASHBOARD_PORT`/`DASHBOARD_HOST` 环境变量覆盖
 *     （`dashboard/server.py:514-520`）
 *   - 鉴权：`dashboard.jwt_secret` 明文在 `data/cmd_config.json` 里，鉴权只做
 *     HS256 验签（`dashboard/api/auth.py:185-217`）→ 本地自签 JWT 即可，零配置
 *   - 就绪：**不能看心跳文件**（state 只有 starting/stopping），探
 *     `GET /api/v1/auth/setup-status`（免鉴权）
 *   - 重载：`POST /api/v1/plugins/reload {"plugin_id": "..."}`，进程内
 *     `sys.modules` 剔除 + 重新 import（`core/star/star_manager.py:705-800`）
 *   - 端到端：`ws://127.0.0.1:<port>/api/v1/unified-chat/ws?token=<JWT>`，
 *     WebChat 适配器**无条件启动**（`core/platform/manager.py:96-102`），
 *     注入的消息走完整事件流水线，插件的 filter/hook 会正常触发
 *   - 实例归属：绝不终止用户自己启动的 AstrBot（桌面端那份），只终结本插件
 *     自己 spawn 的进程
 */

import { defineTool as defineToolOfficial } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { createHmac, createHash, randomUUID } from 'node:crypto'
import {
  existsSync, readFileSync,
} from 'node:fs'
import {
  cp, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-astrbot-plugin-dev'

export const inject = ['subprocess', 'tools', 'systemPrompt']

/**
 * Runtime configuration schema (official cordis Config).
 * 全部字段可选：缺省时按「工具参数 > 环境变量 > settings.json > 本配置 > 自动探测」
 * 的顺序解析。`desktopRoot` 指向 AstrBot 桌面安装根（含 backend/ 的那一层），
 * `defaultRoot` 指向本插件默认使用的隔离测试数据根（等价于 ASTRBOT_ROOT）。
 */
export const Config = Schema.object({
  desktopRoot: Schema.string().default('').volatile(),
  defaultRoot: Schema.string().default('').volatile(),
  defaultPort: Schema.number().default(6186),
  pythonPath: Schema.string().default('').volatile(),
})

const PKG = 'dsh-astrbot-plugin-dev'
const SETTINGS_FILE = 'astrbot-plugin-dev.json'

/** AstrBot 桌面安装根的候选位置（按顺序探测）。 */
const DESKTOP_CANDIDATES = [
  'D:\\Program\\AstrBot',
  'C:\\Program Files\\AstrBot',
  'C:\\Program Files (x86)\\AstrBot',
]

/** python 与 launcher 的相对路径（桌面版固定布局）。 */
const REL_PYTHON = ['backend', 'python', 'python.exe']
const REL_LAUNCHER = ['backend', 'launch_backend.py']
const REL_APPDIR = ['backend', 'app']

export function apply(ctx, config) {
  // ── 基础工具 ────────────────────────────────────────────────────────────
  function readField(spec) {
    // volatile 字段在 DSH >= 0.2 上是冻结的 { get() } 引用，必须经引用读取。
    if (spec && typeof spec.get === 'function') {
      try { return spec.get() } catch (e) { return undefined }
    }
    return spec
  }

  function cfgString(key) {
    const v = readField(config ? config[key] : undefined)
    return typeof v === 'string' ? v.trim() : ''
  }

  function cfgNumber(key, fallback) {
    const v = readField(config ? config[key] : undefined)
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }

  function dshHome() {
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
    return join(homedir(), '.dsh')
  }

  function settingsPath() {
    return join(dshHome(), SETTINGS_FILE)
  }

  // 插件自己的持久化设置（不依赖 profile patch 的写入通道，永远可用）。
  function readSettings() {
    try {
      const p = settingsPath()
      if (!existsSync(p)) return {}
      const txt = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
      const obj = JSON.parse(txt)
      return obj && typeof obj === 'object' ? obj : {}
    } catch (e) {
      return {}
    }
  }

  let settingsCache = null
  function settings() {
    if (settingsCache === null) settingsCache = readSettings()
    return settingsCache
  }

  async function writeSettings(patch) {
    const next = Object.assign({}, settings(), patch)
    for (const k of Object.keys(next)) {
      if (next[k] === '' || next[k] === null || next[k] === undefined) delete next[k]
    }
    const p = settingsPath()
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(next, null, 2) + '\n', 'utf8')
    settingsCache = next
    return next
  }

  // configEditor（DSH >= 0.2）写回 profile patch 的同一行；写不进去不算错误，
  // settings.json 已经落盘。DSH 0.1.x 没有该服务，注入子 ctx 根本不会创建。
  let patchWriter = null
  ctx.inject(['configEditor'], function (cctx) {
    try {
      const editor = cctx.configEditor
      if (!editor || typeof editor.edit !== 'function') return
      patchWriter = async function (patch) {
        const own = ctx.fiber && ctx.fiber.entry ? ctx.fiber.entry : null
        const rows = typeof editor.entries === 'function' ? editor.entries() : []
        const entry = rows.find(function (row) { return row === own })
          || rows.find(function (row) { return row && row.options && row.options.name === PKG })
        if (!entry) {
          throw new Error('cannot locate this plugin\'s configuration entry (this row lives inside the ' +
            'astrbot-plugin-dev preset\'s plugins list, which the patch editor does not address); ' +
            'the value was written to ' + settingsPath() + ' instead')
        }
        await editor.edit(entry, function (previous) {
          return Object.assign({}, previous, patch)
        })
      }
    } catch (e) {
      try { ctx.logger.warn('[' + PKG + '] configEditor wiring skipped: ' + String((e && e.message) || e)) } catch (e2) {}
    }
  })

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  // 工具返回值必须是 lossless JSON：剔掉 undefined / NaN / -0，否则 tool runtime
  // 会以 `"value" must be a lossless JSON object` 拒收整个结果。
  function clean(root) {
    const bad = []
    const seen = new Set()
    function walk(o, path) {
      if (o === null || typeof o !== 'object') return
      if (seen.has(o)) return
      seen.add(o)
      for (const k of Object.keys(o)) {
        const v = o[k]
        const p = path + k
        if (v === undefined) { bad.push(p); delete o[k] } else if (typeof v === 'number') {
          if (!Number.isFinite(v) || Object.is(v, -0)) { bad.push(p); o[k] = null }
        } else if (typeof v === 'object' && v !== null) walk(v, p + '.')
      }
    }
    walk(root, '')
    if (bad.length > 0) {
      try { ctx.logger.warn('[' + PKG + '] sanitized non-lossless fields: ' + bad.join(', ')) } catch (e) {}
    }
    return root
  }

  /**
   * 组装返回值时先剔掉 undefined 字段。
   * clean() 是兜底（它会把这当成异常打 warning），常态缺省字段不该刷屏。
   */
  function compact(obj) {
    const out = {}
    for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k]
    return out
  }

  function truncate(text, max) {
    const s = typeof text === 'string' ? text : String(text === undefined ? '' : text)
    const limit = max || 8000
    if (s.length <= limit) return s
    return s.slice(0, limit) + '\n… [' + (s.length - limit) + ' chars truncated]'
  }

  function tailLines(text, n) {
    const lines = String(text || '').split(/\r?\n/)
    return lines.slice(Math.max(0, lines.length - (n || 60))).join('\n')
  }

  // ── 安装探测 ────────────────────────────────────────────────────────────
  async function readJson(path) {
    const txt = await readFile(path, 'utf8')
    return JSON.parse(txt.replace(/^\uFEFF/, ''))
  }

  function isJsonFile(path) {
    try {
      JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
      return true
    } catch (e) {
      return false
    }
  }

  function installShape(root) {
    const abs = resolve(root)
    const python = join(abs, REL_PYTHON[0], REL_PYTHON[1], REL_PYTHON[2])
    const launcher = join(abs, REL_LAUNCHER[0], REL_LAUNCHER[1])
    if (!existsSync(python) || !existsSync(launcher)) return null
    let manifest = null
    try {
      const mp = join(abs, 'backend', 'runtime-manifest.json')
      if (existsSync(mp)) manifest = JSON.parse(readFileSync(mp, 'utf8'))
    } catch (e) {}
    return { install: abs, python, launcher, appDir: join(abs, REL_APPDIR[0], REL_APPDIR[1]), manifest }
  }

  function desktopCandidates() {
    const out = []
    function push(v) {
      if (typeof v === 'string' && v.trim()) {
        const abs = resolve(v.trim())
        if (!out.includes(abs)) out.push(abs)
      }
    }
    push(cfgString('desktopRoot'))
    push(settings().desktopRoot)
    push(process.env.ASTRBOT_DESKTOP_ROOT)
    push(process.env.ASTRBOT_INSTALL_ROOT)
    for (const c of DESKTOP_CANDIDATES) push(c)
    const local = process.env.LOCALAPPDATA
    if (local) push(join(local, 'Programs', 'AstrBot'))
    push(join(homedir(), 'AstrBot'))
    return out
  }

  function resolveDesktop(explicit) {
    const tried = []
    const list = []
    if (typeof explicit === 'string' && explicit.trim()) list.push(resolve(explicit.trim()))
    list.push.apply(list, desktopCandidates())
    for (const root of list) {
      tried.push(root)
      const shape = installShape(root)
      if (shape) return { ok: true, tried, shape }
    }
    return { ok: false, tried }
  }

  /**
   * AstrBot 的数据根 = ASTRBOT_ROOT = 含 `data/` 的那一层。
   * 桌面版的数据根是 `<install>/AstrBotData`（里面有 data/），不是 install 本身。
   */
  function dataRootsFor(install) {
    const out = []
    const candidate = join(install, 'AstrBotData')
    if (existsSync(join(candidate, 'data'))) out.push(candidate)
    out.push(install)
    return out
  }

  function resolveDesktopData(install) {
    for (const root of dataRootsFor(install)) {
      const cmd = join(root, 'data', 'cmd_config.json')
      if (existsSync(cmd)) return { root, cmdConfig: cmd }
    }
    const fallback = dataRootsFor(install)[0]
    return { root: fallback, cmdConfig: join(fallback, 'data', 'cmd_config.json') }
  }

  function defaultTestRoot() {
    const fromCfg = cfgString('defaultRoot')
    if (fromCfg) return resolve(fromCfg)
    const fromSettings = settings().root
    if (typeof fromSettings === 'string' && fromSettings.trim()) return resolve(fromSettings.trim())
    const fromEnv = process.env.ASTRBOT_TEST_ROOT
    if (typeof fromEnv === 'string' && fromEnv.trim()) return resolve(fromEnv.trim())
    return join(homedir(), '.astrbot-test')
  }

  function pythonFor(fallback) {
    const explicit = settings().pythonPath || cfgString('pythonPath')
    if (explicit && existsSync(explicit)) return resolve(explicit)
    return fallback
  }

  // ── AstrBot 配置读取 ────────────────────────────────────────────────────
  async function loadCmdConfig(root) {
    const p = join(root, 'data', 'cmd_config.json')
    if (!existsSync(p)) return { ok: false, path: p, error: 'cmd_config.json not found at ' + p }
    try {
      const cfg = await readJson(p)
      return { ok: true, path: p, config: cfg }
    } catch (e) {
      return { ok: false, path: p, error: 'cmd_config.json unreadable: ' + String((e && e.message) || e) }
    }
  }

  function dashboardOf(cfg) {
    const d = cfg && cfg.dashboard ? cfg.dashboard : {}
    return {
      enable: d.enable !== false,
      host: typeof d.host === 'string' && d.host ? d.host : '0.0.0.0',
      port: typeof d.port === 'number' ? d.port : 6185,
      username: typeof d.username === 'string' ? d.username : '',
      jwtSecret: typeof d.jwt_secret === 'string' ? d.jwt_secret : '',
      ssl: !!(d.ssl && d.ssl.enable),
    }
  }

  function connectHost(host) {
    if (!host || host === '0.0.0.0' || host === '::' || host === '::0') return '127.0.0.1'
    if (host === 'localhost') return '127.0.0.1'
    return host
  }

  function b64url(buf) {
    return Buffer.from(buf).toString('base64url')
  }

  /** 用 cmd_config.json 里明文的 jwt_secret 自签一个 HS256 token。 */
  function mintJwt(secret, username, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000)
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : 7 * 24 * 3600
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payload = b64url(JSON.stringify({ username: username || 'dsh', iat: now, exp: now + ttl }))
    const sig = createHmac('sha256', secret).update(header + '.' + payload).digest('base64url')
    return { token: header + '.' + payload + '.' + sig, expiresAt: now + ttl }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────
  async function fetchWithTimeout(url, options, timeoutMs) {
    const ac = new AbortController()
    const timer = setTimeout(function () { ac.abort() }, timeoutMs || 15000)
    try {
      const res = await fetch(url, Object.assign({ signal: ac.signal }, options))
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  async function readBody(res) {
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (e) {}
    return { text, json }
  }

  /**
   * 解析出「要访问哪个实例」以及它的鉴权材料。
   * 优先级：显式 baseUrl → root 参数 → 默认测试根 → 桌面实例。
   */
  async function resolveTarget(args) {
    const a = args || {}
    if (typeof a.baseUrl === 'string' && a.baseUrl.trim()) {
      const base = a.baseUrl.trim().replace(/\/+$/, '')
      let jwtSecret = ''
      let username = ''
      const rootGuess = typeof a.root === 'string' && a.root.trim() ? resolve(a.root.trim()) : null
      if (rootGuess) {
        const cfg = await loadCmdConfig(rootGuess)
        if (cfg.ok) {
          const d = dashboardOf(cfg.config)
          jwtSecret = d.jwtSecret
          username = d.username
        }
      }
      if (!jwtSecret) {
        const s = settings()
        jwtSecret = typeof s.jwtSecret === 'string' ? s.jwtSecret : ''
        username = typeof s.username === 'string' ? s.username : ''
      }
      return { base, root: rootGuess, jwtSecret, username, source: 'baseUrl' }
    }

    const explicitRoot = typeof a.root === 'string' && a.root.trim() ? resolve(a.root.trim()) : null
    if (explicitRoot) {
      const cfg = await loadCmdConfig(explicitRoot)
      const d = cfg.ok ? dashboardOf(cfg.config) : { host: '127.0.0.1', port: cfgNumber('defaultPort', 6186), jwtSecret: '', username: '' }
      return {
        base: 'http://' + connectHost(d.host) + ':' + d.port,
        root: explicitRoot,
        jwtSecret: d.jwtSecret,
        username: d.username,
        source: 'root',
        configOk: cfg.ok,
        configError: cfg.ok ? undefined : cfg.error,
      }
    }

    // 默认：本插件起的实例优先，其次默认测试根，最后桌面安装实例。
    if (managed) {
      return {
        base: 'http://127.0.0.1:' + managed.port,
        root: managed.root,
        jwtSecret: managed.jwtSecret,
        username: managed.username,
        source: 'managed',
      }
    }

    const testRoot = defaultTestRoot()
    if (existsSync(join(testRoot, 'data', 'cmd_config.json'))) {
      const cfg = await loadCmdConfig(testRoot)
      const d = dashboardOf(cfg.config)
      return {
        base: 'http://' + connectHost(d.host) + ':' + d.port,
        root: testRoot,
        jwtSecret: d.jwtSecret,
        username: d.username,
        source: 'testRoot',
      }
    }

    const desktop = resolveDesktop()
    if (desktop.ok) {
      const data = resolveDesktopData(desktop.shape.install)
      const cfg = await loadCmdConfig(data.root)
      const d = cfg.ok ? dashboardOf(cfg.config) : { host: '0.0.0.0', port: 6185, jwtSecret: '', username: '' }
      return {
        base: 'http://' + connectHost(d.host) + ':' + d.port,
        root: data.root,
        install: desktop.shape.install,
        jwtSecret: d.jwtSecret,
        username: d.username,
        source: 'desktop',
      }
    }

    return { base: '', source: 'none', error: 'no AstrBot instance could be located; pass root or baseUrl, or set desktopRoot via astrbot_config' }
  }

  async function apiCall(target, method, path, body, opts) {
    const o = opts || {}
    const url = target.base + path
    const headers = { Accept: 'application/json' }
    if (o.auth !== 'none') {
      if (o.auth === 'apikey' && o.apiKey) {
        headers.Authorization = 'ApiKey ' + o.apiKey
      } else if (target.jwtSecret) {
        headers.Authorization = 'Bearer ' + mintJwt(target.jwtSecret, target.username || 'dsh').token
      }
    }
    let payload
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const res = await fetchWithTimeout(url, { method: method || 'GET', headers, body: payload }, o.timeoutMs || 20000)
    const parsed = await readBody(res)
    return { status: res.status, ok: res.ok, url, json: parsed.json, text: parsed.text }
  }

  /** 统一的结果包装：HTTP 非 2xx 也要把服务端 message 带回去。 */
  function apiResult(res, maxText) {
    const out = { http_status: res.status, ok: res.ok, url: res.url }
    if (res.json !== null && typeof res.json === 'object') {
      out.response = res.json
      if (res.json.status && res.json.status !== 'ok') out.error = String(res.json.message || res.json.status)
    } else {
      out.response_text = truncate(res.text, maxText || 4000)
      if (!res.ok) out.error = 'HTTP ' + res.status
    }
    return out
  }

  async function probeReady(base, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 3000)
    let last = ''
    while (Date.now() < deadline) {
      try {
        const res = await fetchWithTimeout(base + '/api/v1/auth/setup-status', { method: 'GET' }, Math.min(2500, Math.max(500, deadline - Date.now())))
        if (res.status >= 200 && res.status < 500) return { ready: true, status: res.status }
        last = 'HTTP ' + res.status
      } catch (e) {
        last = String((e && e.message) || e)
      }
      await sleep(250)
    }
    return { ready: false, error: last || 'timeout' }
  }

  // ── 受管进程 ────────────────────────────────────────────────────────────
  let managed = null // { handle, root, port, pid, startedAt, jwtSecret, username, install, stdoutOffset, stderrOffset }

  function readCollected(handle, which, fromOffset) {
    try {
      const reader = handle && handle.collected ? handle.collected[which] : null
      if (!reader || typeof reader.readFrom !== 'function') return { text: '', nextOffset: fromOffset || 0, lossy: false }
      return reader.readFrom(fromOffset || 0)
    } catch (e) {
      return { text: '', nextOffset: fromOffset || 0, lossy: false, error: String((e && e.message) || e) }
    }
  }

  function drainManagedLog(inst) {
    const m = inst || managed
    if (!m || !m.handle) return { stdout: '', stderr: '' }
    const o = readCollected(m.handle, 'stdout', m.stdoutOffset)
    const e = readCollected(m.handle, 'stderr', m.stderrOffset)
    m.stdoutOffset = o.nextOffset || m.stdoutOffset
    m.stderrOffset = e.nextOffset || m.stderrOffset
    return { stdout: o.text || '', stderr: e.text || '', lossy: !!(o.lossy || e.lossy) }
  }

  /** launch_backend.py 会按这个环境变量每 2s 写心跳（含 pid/state）。 */
  function readHeartbeat(root) {
    try {
      const p = join(root, 'data', 'backend-startup-heartbeat.json')
      if (!existsSync(p)) return null
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch (e) {
      return null
    }
  }

  // 进程退出时留下最后一段输出，供 astrbot_start / astrbot_status 解释失败原因。
  let managedExit = null

  async function portInUse(port, host) {
    return await new Promise(function (res) {
      const url = 'http://' + connectHost(host || '127.0.0.1') + ':' + port + '/api/v1/auth/setup-status'
      const ac = new AbortController()
      const timer = setTimeout(function () { ac.abort(); res(false) }, 2000)
      fetch(url, { signal: ac.signal }).then(function (r) {
        clearTimeout(timer)
        res(r.status < 500)
      }).catch(function () {
        clearTimeout(timer)
        res(false)
      })
    })
  }

  // ── 端到端注入（WebSocket） ──────────────────────────────────────────────
  /**
   * 通过 WebChat 通道把一条消息注入真实事件流水线。
   * 协议（dashboard/services/live_chat_service.py）：
   *   发 {"ct":"chat","t":"send","message_id":<唯一>,"session_id":<会话>,
   *       "message":[{"type":"plain","text":"..."}]}
   *   收 {"ct":"chat","type":"plain","data":"...","streaming":true} 片段
   *   收 {"ct":"chat","type":"end",...} 结束（必须按 message_id 关联）
   */
  async function injectChat(opts) {
    const url = opts.url
    const payload = opts.payload
    const timeoutMs = opts.timeoutMs || 120000
    if (typeof WebSocket !== 'function') {
      return { error: 'this Node runtime has no global WebSocket; use astrbot_api with POST /api/chat/send instead' }
    }
    return await new Promise(function (resolveOuter) {
      const events = []
      let reply = ''
      let settled = false
      let ws = null
      let timer = null

      function finish(extra) {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try { if (ws) ws.close() } catch (e) {}
        resolveOuter(clean(Object.assign({ reply: reply, events: events }, extra || {})))
      }

      try {
        ws = new WebSocket(url)
      } catch (e) {
        resolveOuter({ error: 'websocket construction failed: ' + String((e && e.message) || e) })
        return
      }

      timer = setTimeout(function () { finish({ timed_out: true }) }, timeoutMs)

      ws.addEventListener('open', function () {
        try { ws.send(JSON.stringify(payload)) } catch (e) { finish({ error: 'send failed: ' + String((e && e.message) || e) }) }
      })

      ws.addEventListener('message', function (ev) {
        let msg = null
        try { msg = JSON.parse(String(ev.data)) } catch (e) { return }
        events.push(msg)
        if (!msg || msg.ct !== 'chat') return
        if (msg.t === 'error' || msg.type === 'error') {
          finish({ error: String(msg.data || 'chat error'), error_code: msg.code })
          return
        }
        if (msg.type === 'plain' && typeof msg.data === 'string') {
          if (msg.streaming) {
            // 流式片段可能是增量也可能是累积快照，两种都接住。
            if (reply && msg.data.startsWith(reply)) reply = msg.data
            else reply += msg.data
          } else {
            reply = msg.data
          }
        }
        if (msg.type === 'end' || msg.t === 'end') finish({})
      })

      ws.addEventListener('error', function () {
        finish({ error: 'websocket error (is the instance running and the token valid?)' })
      })

      ws.addEventListener('close', function () {
        finish({ closed: true })
      })
    })
  }

  // ── 目录复制（部署） ────────────────────────────────────────────────────
  const DEPLOY_SKIP = new Set(['.git', '.build', '__pycache__', 'node_modules', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache'])

  function shouldSkip(name, extra) {
    if (DEPLOY_SKIP.has(name)) return true
    if (extra && extra.includes(name)) return true
    if (name.endsWith('.pyc') || name.endsWith('.pyo')) return true
    return false
  }

  async function hashFile(path) {
    try {
      const buf = await readFile(path)
      return createHash('md5').update(buf).digest('hex')
    } catch (e) {
      return ''
    }
  }

  async function countTree(root) {
    let files = 0
    let bytes = 0
    async function walk(dir) {
      let entries = []
      try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { return }
      for (const ent of entries) {
        if (shouldSkip(ent.name, null)) continue
        const p = join(dir, ent.name)
        if (ent.isDirectory()) await walk(p)
        else if (ent.isFile()) {
          files += 1
          try { bytes += (await stat(p)).size } catch (e) {}
        }
      }
    }
    await walk(root)
    return { files, bytes }
  }

  function detectEntryFile(dir, name) {
    const candidates = ['main.py', name + '.py', '__init__.py']
    for (const c of candidates) {
      const p = join(dir, c)
      if (existsSync(p)) return p
    }
    return null
  }

  // ── 工具定义 ────────────────────────────────────────────────────────────
  function defineTool(opt) {
    const parameters = {}
    const required = opt.required || []
    for (const key of Object.keys(opt.properties || {})) {
      const spec = Object.assign({}, opt.properties[key])
      if (required.includes(key)) spec.required = true
      parameters[key] = spec
    }
    const def = {
      name: opt.name,
      description: opt.description,
      parameters: parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: function (_args, value) {
          return [{ type: 'text', text: JSON.stringify(value) }]
        },
      },
    }
    if (opt.timeoutMs) def.timeoutMs = opt.timeoutMs
    def.execute = async function (args, exec) {
      try {
        return clean(await opt.execute(args, exec))
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }
    return defineToolOfficial(def)
  }

  const OUT = { type: 'object', additionalProperties: true }

  const defs = [
    // ── 配置 ─────────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_config',
      description: '查看或写入本插件的持久设置（AstrBot 安装根、默认隔离测试根、默认端口、Python 解释器路径）。不带任何参数即返回当前生效的设置与自动探测结果；带参数则写入 $DSH_HOME/astrbot-plugin-dev.json（并尽力同步进 profile 组合配置）。当 astrbot_status 报「找不到 AstrBot 安装」时，用 desktop_root 指定安装目录（含 backend/ 的那一层，例如 D:\\Program\\AstrBot）。',
      properties: {
        desktop_root: { type: 'string', description: 'AstrBot 桌面安装根目录（含 backend/python/python.exe 的那一层）' },
        test_root: { type: 'string', description: '默认隔离测试实例的数据根（等价于 ASTRBOT_ROOT；其下有 data/plugin…）' },
        default_port: { type: 'number', description: '默认给隔离实例用的 dashboard 端口（默认 6186；不要用桌面实例的 6185）' },
        python_path: { type: 'string', description: '覆盖 Python 解释器路径（默认用 <安装根>/backend/python/python.exe）' },
        clear: { type: 'array', description: '要清空的设置键名，例如 ["test_root"]', items: { type: 'string' } },
      },
      async execute(args) {
        const patch = {}
        const clear = Array.isArray(args.clear) ? args.clear : []
        if (typeof args.desktop_root === 'string' && args.desktop_root.trim()) patch.desktopRoot = resolve(args.desktop_root.trim())
        if (typeof args.test_root === 'string' && args.test_root.trim()) patch.root = resolve(args.test_root.trim())
        if (typeof args.default_port === 'number' && Number.isFinite(args.default_port)) patch.defaultPort = args.default_port
        if (typeof args.python_path === 'string' && args.python_path.trim()) patch.pythonPath = resolve(args.python_path.trim())
        for (const k of clear) if (typeof k === 'string') patch[k] = ''

        // 注意：patchResult 必须声明在 if 之外 —— 返回值里的 patch_write 引用它，
        // 而返回值在 if 块外（旧写法把 let 写在块内，一改设置就 ReferenceError）。
        let patchResult
        if (Object.keys(patch).length > 0) {
          for (const [k, v] of Object.entries(patch)) {
            if (typeof v === 'string' && v && k !== 'root' && k !== 'pythonPath' && !existsSync(v)) {
              return { error: k + ' does not exist: ' + v }
            }
          }
          await writeSettings(patch)
          patchResult = 'skipped (settings file is authoritative)'
          if (patchWriter) {
            try {
              await patchWriter({
                desktopRoot: settings().desktopRoot || '',
                defaultRoot: settings().root || '',
                defaultPort: typeof settings().defaultPort === 'number' ? settings().defaultPort : cfgNumber('defaultPort', 6186),
                pythonPath: settings().pythonPath || '',
              })
              patchResult = 'written to the profile patch'
            } catch (e) {
              patchResult = 'profile patch not updated: ' + String((e && e.message) || e)
            }
          }
        }

        const desktop = resolveDesktop()
        const probe = {}
        if (desktop.ok) {
          const data = resolveDesktopData(desktop.shape.install)
          probe.desktop = {
            install: desktop.shape.install,
            data_root: data.root,
            python: desktop.shape.python,
            launcher: desktop.shape.launcher,
            core_version: desktop.shape.manifest ? desktop.shape.manifest.coreVersion : undefined,
            desktop_version: desktop.shape.manifest ? desktop.shape.manifest.desktopVersion : undefined,
          }
        } else {
          probe.desktop_install_not_found = true
          probe.tried = desktop.tried
        }
        probe.test_root = defaultTestRoot()
        probe.test_root_exists = existsSync(join(defaultTestRoot(), 'data', 'cmd_config.json'))
        return {
          success: true,
          changed: Object.keys(patch).length > 0 ? patch : undefined,
          settings_file: settingsPath(),
          settings: settings(),
          patch_write: Object.keys(patch).length > 0 ? patchResult : undefined,
          probe: probe,
        }
      },
    }),

    // ── 总览 ─────────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_status',
      description: 'AstrBot 环境与实例总览：桌面安装位置与版本、解释器、数据根、当前实例是否在线（探 /api/v1/auth/setup-status，免鉴权）、dashboard 端口与用户名、jwt_secret 是否可读、已加载插件数与加载失败的插件、日志落盘位置。开始任何 AstrBot 工作前先跑它一次。deep=true 时额外拉取插件清单与失败详情。',
      properties: {
        root: { type: 'string', description: '实例数据根（ASTRBOT_ROOT）。省略则用默认测试根或桌面实例' },
        base_url: { type: 'string', description: '直接指定 dashboard 基址，如 http://127.0.0.1:6186' },
        deep: { type: 'boolean', description: '是否额外查询插件清单与失败列表' },
      },
      async execute(args) {
        const desktop = resolveDesktop()
        const out = { now: new Date().toISOString() }
        if (desktop.ok) {
          const shape = desktop.shape
          const data = resolveDesktopData(shape.install)
          const cfg = await loadCmdConfig(data.root)
          const d = cfg.ok ? dashboardOf(cfg.config) : null
          out.desktop_install = {
            install: shape.install,
            data_root: data.root,
            python: shape.python,
            launcher: shape.launcher,
            core_version: shape.manifest ? shape.manifest.coreVersion : undefined,
            desktop_version: shape.manifest ? shape.manifest.desktopVersion : undefined,
            source_ref: shape.manifest ? shape.manifest.sourceRef : undefined,
            webui_dist: existsSync(join(data.root, 'data', 'dist')) ? join(data.root, 'data', 'dist') : undefined,
          }
          if (d) {
            out.desktop_dashboard = {
              host: d.host,
              port: d.port,
              username: d.username,
              jwt_secret_available: !!d.jwtSecret,
              base_url: 'http://' + connectHost(d.host) + ':' + d.port,
            }
            const hb = join(data.root, 'data', 'backend-startup-heartbeat.json')
            if (existsSync(hb)) {
              try { out.desktop_heartbeat = JSON.parse(readFileSync(hb, 'utf8')) } catch (e) {}
            }
            const ready = await probeReady('http://' + connectHost(d.host) + ':' + d.port, 2500)
            out.desktop_instance_running = ready.ready
            if (!ready.ready) out.desktop_probe_error = ready.error
          }
        } else {
          out.desktop_install_not_found = true
          out.tried = desktop.tried
          out.hint = '用 astrbot_config(desktop_root="<AstrBot 安装目录>") 指定，或设置环境变量 ASTRBOT_DESKTOP_ROOT'
        }

        const testRoot = defaultTestRoot()
        out.default_test_root = testRoot
        out.default_test_root_initialized = existsSync(join(testRoot, 'data', 'cmd_config.json'))
        if (managed) {
          out.managed_instance = compact({
            root: managed.root,
            port: managed.port,
            pid: managed.pid,
            started_at: managed.startedAt,
            alive: managedExit === null,
          })
        }
        if (managedExit) out.last_managed_exit = managedExit

        const target = await resolveTarget(args)
        out.target = {
          source: target.source,
          base_url: target.base || undefined,
          root: target.root || undefined,
          jwt_available: !!target.jwtSecret,
          username: target.username || undefined,
        }
        if (target.error) out.target.error = target.error

        if (target.base) {
          const ready = await probeReady(target.base, 3000)
          out.target.reachable = ready.ready
          if (ready.status !== undefined) out.target.setup_status_http = ready.status
          if (!ready.ready && ready.error) out.target.probe_error = ready.error
          if (ready.ready && args.deep) {
            const plugins = await apiCall(target, 'GET', '/api/v1/plugins', undefined, {})
            if (plugins.ok && plugins.json && plugins.json.data) {
              const list = plugins.json.data.plugins || plugins.json.data
              out.plugins = Array.isArray(list)
                ? list.map(function (p) { return { id: p.name || p.id || p.plugin_id, version: p.version, activated: p.activated } })
                : list
              out.plugin_count = Array.isArray(list) ? list.length : undefined
            } else {
              out.plugins_error = apiResult(plugins, 800)
            }
            const failed = await apiCall(target, 'GET', '/api/v1/plugins/failed', undefined, {})
            if (failed.ok && failed.json && failed.json.data) {
              const f = failed.json.data
              out.failed_plugins = Array.isArray(f) ? f : (f.plugins || f.failed || f)
            } else if (!failed.ok) {
              out.failed_plugins_error = apiResult(failed, 500)
            }
          }
        }
        return out
      },
    }),

    // ── 启动 / 停止 ──────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_start',
      description: '启动一个受本插件管理的 AstrBot 后端实例（隔离测试用），或接管一个已在同端口应答的实例（返回 external:true，此时不会去终止它）。默认会：① 用 ASTRBOT_ROOT 指向独立的测试数据根；② 若是首次则从桌面实例的 cmd_config.json 复制一份并改成隔离配置（换端口、关掉所有平台以免抢线上账号/端口、打开文件日志）；③ 探 /api/v1/auth/setup-status 确认就绪后才返回。绝不使用桌面实例正在占用的端口（默认 6185，请用 6186+）。',
      timeoutMs: 240000,
      properties: {
        root: { type: 'string', description: '测试实例的数据根（ASTRBOT_ROOT）。省略则用 astrbot_config 里的 test_root 或 ~/.astrbot-test' },
        port: { type: 'number', description: 'dashboard 端口，默认 6186。必须避开桌面实例的 6185' },
        host: { type: 'string', description: 'dashboard 绑定地址，默认 127.0.0.1' },
        seed_from_desktop: { type: 'boolean', description: '首次初始化时是否复制桌面实例的 cmd_config.json（保留 provider/密钥），默认 true' },
        disable_platforms: { type: 'boolean', description: '是否把配置里所有平台 enable 改成 false，默认 true（防抢端口/防真发消息）' },
        enable_file_log: { type: 'boolean', description: '是否打开 log_file_enable 并指定日志文件，默认 true' },
        copy_plugins: { type: 'boolean', description: '是否把桌面实例 data/plugins 下的插件复制进测试实例（默认 false，用 astrbot_deploy 单独部署更可控）' },
        wait_ms: { type: 'number', description: '等待就绪的上限毫秒数，默认 90000' },
      },
      async execute(args) {
        const desktop = resolveDesktop()
        if (!desktop.ok) {
          return { error: 'AstrBot desktop install not found', tried: desktop.tried, hint: 'run astrbot_config(desktop_root="...") first' }
        }
        const install = desktop.shape.install
        const root = typeof args.root === 'string' && args.root.trim() ? resolve(args.root.trim()) : defaultTestRoot()
        const port = Number.isFinite(args.port) ? args.port : cfgNumber('defaultPort', (settings().defaultPort || 6186))
        const host = typeof args.host === 'string' && args.host.trim() ? args.host.trim() : '127.0.0.1'

        if (managed && managedExit === null && managed.port === port && managed.root === root) {
          return {
            success: true, already_managed: true, external: false, root, port, pid: managed.pid,
            base_url: 'http://127.0.0.1:' + port,
            note: 'this plugin already manages an instance on that port',
          }
        }

        // 端口上已经有人应答 → 接管，绝不重复启动、绝不终结别人的进程。
        if (await portInUse(port, host)) {
          const cfg = await loadCmdConfig(root)
          const d = cfg.ok ? dashboardOf(cfg.config) : { jwtSecret: '', username: '' }
          return {
            success: true,
            external: true,
            adopted: true,
            root,
            port,
            base_url: 'http://127.0.0.1:' + port,
            jwt_available: !!d.jwtSecret,
            note: 'an AstrBot instance already answers on this port; adopted it. astrbot_stop will refuse to terminate an adopted instance.',
          }
        }

        // ── 首次初始化：造一份隔离配置 ──
        const dataRoot = root
        const dataDir = join(dataRoot, 'data')
        const cmdPath = join(dataDir, 'cmd_config.json')
        const bootstrapped = { created: false }
        if (!existsSync(cmdPath)) {
          await mkdir(dataDir, { recursive: true })
          let seed = null
          if (args.seed_from_desktop !== false) {
            const dData = resolveDesktopData(install)
            const dCfg = await loadCmdConfig(dData.root)
            if (dCfg.ok) seed = dCfg.config
          }
          let cfg = seed
          if (!cfg) {
            return {
              error: 'no cmd_config.json to seed from (desktop config unreadable) and the test root is empty; ' +
                'start the desktop AstrBot once so it writes data/cmd_config.json, or pass seed_from_desktop:false after creating one by hand',
              root,
            }
          }
          cfg = JSON.parse(JSON.stringify(cfg))
          cfg.dashboard = Object.assign({}, cfg.dashboard, { enable: true, host, port })
          if (args.disable_platforms !== false) {
            if (Array.isArray(cfg.platform)) {
              cfg.platform = cfg.platform.map(function (p) { return Object.assign({}, p, { enable: false }) })
            } else if (cfg.platform && typeof cfg.platform === 'object') {
              cfg.platform = Object.fromEntries(Object.entries(cfg.platform).map(function (kv) {
                return [kv[0], Object.assign({}, kv[1], { enable: false })]
              }))
            }
            if (cfg.platform_settings && typeof cfg.platform_settings === 'object') {
              cfg.platform_settings = Object.assign({}, cfg.platform_settings, { id_whitelist: [], id_whitelist_enable: false })
            }
          }
          if (args.enable_file_log !== false) {
            cfg.log_file_enable = true
            cfg.log_file_path = join(dataDir, 'logs', 'astrbot.log')
            cfg.log_file_max_mb = 20
          }
          cfg.disable_metrics = true
          await writeFile(cmdPath, JSON.stringify(cfg, null, 2), 'utf8')
          bootstrapped.created = true
          bootstrapped.seeded_from_desktop = !!(args.seed_from_desktop !== false)
          bootstrapped.platforms_disabled = args.disable_platforms !== false
        } else if (!existsSync(dataDir)) {
          await mkdir(dataDir, { recursive: true })
        }

        if (args.copy_plugins) {
          const dData = resolveDesktopData(install)
          const src = join(dData.root, 'data', 'plugins')
          if (existsSync(src)) {
            await cp(src, join(dataDir, 'plugins'), {
              recursive: true,
              force: true,
              filter: function (s) { return !shouldSkip(s.split(/[\\/]/).pop(), null) },
            })
            bootstrapped.plugins_copied = true
          }
        }

        const data = resolveDesktopData(install)
        const webui = join(data.root, 'data', 'dist')
        const argv = [desktop.shape.python, desktop.shape.launcher]
        if (existsSync(webui)) argv.push('--webui-dir', webui)

        const heartbeatPath = join(dataDir, 'backend-startup-heartbeat.json')
        const env = Object.assign({}, process.env, {
          ASTRBOT_ROOT: dataRoot,
          DASHBOARD_PORT: String(port),
          DASHBOARD_HOST: host,
          // launch_backend.py 只在有这个环境变量时才写心跳；写了就能拿到真实 pid 与 state
          // （subprocess 服务给的 handle 上没有 pid，这是唯一可靠来源）。
          ASTRBOT_BACKEND_STARTUP_HEARTBEAT_PATH: heartbeatPath,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        })
        delete env.ASTRBOT_DESKTOP_CLIENT
        delete env.ASTRBOT_DESKTOP_MANAGED

        let handle
        try {
          handle = ctx.subprocess.spawn({
            argv: argv,
            cwd: desktop.shape.appDir,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 512 * 1024 },
              stderr: { maxBytes: 512 * 1024 },
            },
            graceMs: 5000,
            env: env,
          })
        } catch (e) {
          return { error: 'failed to spawn AstrBot: ' + String((e && e.message) || e), argv }
        }

        managed = {
          handle,
          root: dataRoot,
          port,
          // pid 在就绪后从心跳文件补（SubprocessHandle 上没有 pid）
          pid: undefined,
          startedAt: new Date().toISOString(),
          install,
          jwtSecret: '',
          username: '',
          stdoutOffset: 0,
          stderrOffset: 0,
        }
        managedExit = null
        const self = managed
        handle.done.then(function (outcome) {
          if (managed !== self) return
          const drained = drainManagedLog()
          managedExit = {
            at: new Date().toISOString(),
            exit_code: outcome ? outcome.exitCode : null,
            signal: outcome ? outcome.signal : null,
            stdout_tail: tailLines(drained.stdout, 40),
            stderr_tail: tailLines(drained.stderr, 40),
          }
        }).catch(function (err) {
          if (managed !== self) return
          managedExit = { at: new Date().toISOString(), error: String((err && err.message) || err) }
        })

        // ── 等待就绪 ──
        const waitMs = Number.isFinite(args.wait_ms) ? args.wait_ms : 90000
        const base = 'http://' + connectHost(host) + ':' + port
        const deadline = Date.now() + waitMs
        let ready = false
        while (Date.now() < deadline) {
          if (managedExit) break
          try {
            const res = await fetchWithTimeout(base + '/api/v1/auth/setup-status', { method: 'GET' }, 2500)
            if (res.status < 500) { ready = true; break }
          } catch (e) {}
          await sleep(500)
        }

        const log = drainManagedLog()
        // pid 从心跳文件补（handle 上没有 pid）
        const hb = readHeartbeat(dataRoot)
        if (hb && hb.pid) managed.pid = hb.pid
        const cfgNow = await loadCmdConfig(dataRoot)
        if (cfgNow.ok) {
          const d = dashboardOf(cfgNow.config)
          managed.jwtSecret = d.jwtSecret
          managed.username = d.username
        }

        if (!ready) {
          return compact({
            success: false,
            error: managedExit ? 'AstrBot exited before becoming ready' : 'AstrBot did not become ready within ' + waitMs + ' ms',
            root: dataRoot,
            port,
            pid: managed.pid,
            base_url: base,
            exit: managedExit || undefined,
            stdout_tail: tailLines(log.stdout, 40) || undefined,
            stderr_tail: tailLines(log.stderr, 40) || undefined,
            hint: '看 stderr_tail：常见原因是端口被占（dashboard/server.py:559 会直接 raise）、cmd_config.json 损坏、或 BOM 处理问题',
          })
        }

        return compact({
          success: true,
          external: false,
          ready: true,
          root: dataRoot,
          port,
          pid: managed.pid,
          started_at: managed.startedAt,
          base_url: base,
          jwt_available: !!managed.jwtSecret,
          username: managed.username,
          bootstrap: bootstrapped,
          stdout_tail: tailLines(log.stdout, 15) || undefined,
          stderr_tail: tailLines(log.stderr, 15) || undefined,
        })
      },
    }),

    defineTool({
      name: 'astrbot_stop',
      description: '停止由 astrbot_start 启动的 AstrBot 实例。只终结本插件自己 spawn 的进程；对「接管」来的实例（用户在桌面端启动的那份，external:true）一律拒绝，并告诉用户该怎么停。',
      properties: {
        force: { type: 'boolean', description: '保留参数：仅影响等待时长，不会去杀别人的进程' },
      },
      async execute() {
        if (!managed) {
          if (managedExit) return { success: true, already_stopped: true, exit: managedExit }
          return { success: true, nothing_managed: true, note: 'no plugin-managed AstrBot instance is running; astrbot_stop never touches instances started by the user/desktop app' }
        }
        const m = managed
        try { m.handle.terminate() } catch (e) {}
        let exited = false
        try {
          exited = await m.handle.waitForExit()
        } catch (e) {}
        const log = drainManagedLog()
        managed = null
        return compact({
          success: true,
          stopped: true,
          exited: exited,
          root: m.root,
          port: m.port,
          stdout_tail: tailLines(log.stdout, 20) || undefined,
          stderr_tail: tailLines(log.stderr, 20) || undefined,
          note: 'to stop an instance you started in the AstrBot desktop app, quit it from its own UI — this plugin never kills it',
        })
      },
    }),

    // ── 鉴权 ─────────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_token',
      description: '读实例的 data/cmd_config.json，用其中明文的 dashboard.jwt_secret 自签一个 HS256 的 Dashboard JWT 并返回。鉴权链路只做验签、不查库不校验密码（dashboard/api/auth.py:185-217），因此这个 token 等价于管理员。可传给脚本/curl 用。',
      properties: {
        root: { type: 'string', description: '实例数据根（ASTRBOT_ROOT）' },
        base_url: { type: 'string', description: 'dashboard 基址' },
        ttl_seconds: { type: 'number', description: '有效期秒数，默认 7 天' },
      },
      async execute(args) {
        const target = await resolveTarget(args)
        if (!target.jwtSecret) {
          return {
            error: 'no jwt_secret available for ' + (target.base || target.source),
            hint: '确认 root 指向的目录下有 data/cmd_config.json，且 dashboard.jwt_secret 非空；若实例从没启动过，先 astrbot_start 一次让它把配置写出来',
          }
        }
        const minted = mintJwt(target.jwtSecret, target.username || 'dsh', args.ttl_seconds)
        return {
          success: true,
          base_url: target.base,
          username: target.username || 'dsh',
          token: minted.token,
          expires_at: new Date(minted.expiresAt * 1000).toISOString(),
          usage: {
            header: 'Authorization: Bearer <token>',
            example: 'curl -H "Authorization: Bearer <token>" ' + target.base + '/api/v1/plugins',
            websocket: target.base.replace(/^http/, 'ws') + '/api/v1/unified-chat/ws?token=<token>',
          },
        }
      },
    }),

    // ── 通用 REST ────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_api',
      description: '带鉴权调用 AstrBot Dashboard/Open API 的任意路由（默认自动用自签 JWT）。用来做本插件没封装的事情：读/写插件配置（GET|PUT /api/v1/plugins/config）、开关插件（PATCH /api/v1/plugins/enabled）、列会话、看 Open API 文档（GET /api/v1/openapi.json）、发 Open API 请求（POST /api/v1/chat，SSE）等。注意插件管理有两套命名空间：/api/v1/plugins/（复数，接受 API Key 或 JWT）与 /api/plugin/（单数，只接受 JWT）。',
      timeoutMs: 120000,
      properties: {
        method: { type: 'string', description: 'HTTP 方法，默认 GET' },
        path: { type: 'string', description: '以 / 开头的路径，例如 /api/v1/plugins/failed' },
        body: { type: 'object', description: 'JSON 请求体' },
        root: { type: 'string', description: '实例数据根' },
        base_url: { type: 'string', description: 'dashboard 基址' },
        auth: { type: 'string', description: "鉴权方式：jwt（默认）| none | apikey" },
        api_key: { type: 'string', description: 'auth=apikey 时使用' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认 20000' },
        max_text: { type: 'number', description: '非 JSON 响应最多回多少字符，默认 4000' },
      },
      async execute(args) {
        if (typeof args.path !== 'string' || !args.path.startsWith('/')) return { error: 'path must start with "/"' }
        const target = await resolveTarget(args)
        if (!target.base) return { error: target.error || 'no target instance' }
        const res = await apiCall(target, String(args.method || 'GET').toUpperCase(), args.path, args.body, {
          auth: args.auth || 'jwt',
          apiKey: args.api_key,
          timeoutMs: Number.isFinite(args.timeout_ms) ? args.timeout_ms : 20000,
        })
        const out = apiResult(res, Number.isFinite(args.max_text) ? args.max_text : 4000)
        out.base_url = target.base
        out.root = target.root || undefined
        if (String(args.method || 'GET').toUpperCase() === 'GET' && /^\/api\/v1\/plugins\/?$/.test(args.path) && res.json && res.json.data) {
          const list = res.json.data.plugins || res.json.data
          if (Array.isArray(list)) {
            out.plugin_ids = list.map(function (p) { return p.name || p.id || p.plugin_id })
          }
        }
        return out
      },
    }),

    // ── 插件管理 ─────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_plugins',
      description: '查看 AstrBot 实例里的插件：list（已加载清单）/ failed（加载失败与 traceback）/ detail（单个插件详情）/ config（某插件的运行时配置）/ schema（某插件的 _conf_schema.json 投影）。改完插件代码后先用 failed 确认没有导入期异常。',
      properties: {
        action: { type: 'string', description: 'list | failed | detail | config | schema，默认 list' },
        plugin_id: { type: 'string', description: '插件目录名，如 astrbot_plugin_quillplus（action=detail/config/schema 时必填）' },
        root: { type: 'string', description: '实例数据根' },
        base_url: { type: 'string', description: 'dashboard 基址' },
      },
      async execute(args) {
        const action = String(args.action || 'list')
        const target = await resolveTarget(args)
        if (!target.base) return { error: target.error || 'no target instance' }
        const id = typeof args.plugin_id === 'string' ? args.plugin_id.trim() : ''
        let path = '/api/v1/plugins'
        if (action === 'failed') path = '/api/v1/plugins/failed'
        else if (action === 'detail') path = '/api/v1/plugins/' + encodeURIComponent(id)
        else if (action === 'config') path = '/api/v1/plugins/' + encodeURIComponent(id) + '/config'
        else if (action === 'schema') path = '/api/v1/plugins/' + encodeURIComponent(id) + '/config/schema'
        if (action !== 'list' && action !== 'failed' && !id) return { error: 'plugin_id is required for action=' + action }
        const res = await apiCall(target, 'GET', path, undefined, {})
        const out = apiResult(res, 6000)
        out.action = action
        out.base_url = target.base
        return out
      },
    }),

    defineTool({
      name: 'astrbot_reload',
      description: '热重载一个插件（POST /api/v1/plugins/reload）并自动复查加载失败列表。AstrBot 的重载是「从 sys.modules 剔除该插件的全部模块再重新 import」，不是 importlib.reload —— 模块级全局状态会丢、插件实例会重新构造，改完代码调一次即可生效，无需重启进程。返回里若 failed=true，说明重载后该插件进了失败字典，看 error_trace。',
      timeoutMs: 60000,
      properties: {
        plugin_id: { type: 'string', description: '插件目录名，如 astrbot_plugin_quillplus' },
        root: { type: 'string', description: '实例数据根' },
        base_url: { type: 'string', description: 'dashboard 基址' },
        settle_ms: { type: 'number', description: '重载后等待多久再查失败列表，默认 1500' },
        check_failed: { type: 'boolean', description: '是否复查失败列表，默认 true' },
      },
      required: ['plugin_id'],
      async execute(args) {
        const id = String(args.plugin_id || '').trim()
        if (!id) return { error: 'plugin_id is required' }
        const target = await resolveTarget(args)
        if (!target.base) return { error: target.error || 'no target instance' }
        const res = await apiCall(target, 'POST', '/api/v1/plugins/reload', { plugin_id: id }, {})
        const out = apiResult(res, 4000)
        out.plugin_id = id
        out.reloaded = res.ok
        if (args.check_failed !== false) {
          await sleep(Number.isFinite(args.settle_ms) ? args.settle_ms : 1500)
          const failed = await apiCall(target, 'GET', '/api/v1/plugins/failed', undefined, {})
          const data = failed.ok && failed.json ? failed.json.data : null
          const list = Array.isArray(data) ? data : (data && (data.plugins || data.failed)) || []
          const hit = Array.isArray(list) ? list.find(function (p) {
            const name = p && (p.name || p.plugin_id || p.dir_name || p.id)
            return name === id
          }) : null
          out.failed = !!hit
          if (hit) out.failure = hit
          else out.failed = false
        }
        return out
      },
    }),

    // ── 日志 ─────────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_logs',
      description: '取 AstrBot 日志：source=file 读后端日志文件的尾部（需要实例开着 log_file_enable）；source=sse 连 /api/v1/logs/live 的 SSE 流收集若干秒；source=history 取 /api/v1/logs/history。注意插件里的 print() 不会进日志通道，只有 logger.info() 会。',
      timeoutMs: 90000,
      properties: {
        source: { type: 'string', description: 'file | sse | history，默认 file' },
        lines: { type: 'number', description: 'file 模式取末尾多少行，默认 120' },
        seconds: { type: 'number', description: 'sse 模式收集多少秒，默认 5' },
        filter: { type: 'string', description: '只保留包含该子串的行（大小写不敏感）' },
        root: { type: 'string', description: '实例数据根' },
        base_url: { type: 'string', description: 'dashboard 基址' },
      },
      async execute(args) {
        const source = String(args.source || 'file')
        const filter = typeof args.filter === 'string' && args.filter ? args.filter.toLowerCase() : ''
        const keep = function (line) { return !filter || String(line).toLowerCase().includes(filter) }

        if (source === 'file') {
          const root = typeof args.root === 'string' && args.root.trim()
            ? resolve(args.root.trim())
            : (managed ? managed.root : defaultTestRoot())
          const cfg = await loadCmdConfig(root)
          const candidates = []
          if (cfg.ok) {
            let lp = cfg.config.log_file_path
            if (typeof lp === 'string' && lp) {
              if (!isAbsolute(lp)) lp = join(root, lp)
              candidates.push(lp)
            }
          }
          candidates.push(join(root, 'data', 'logs', 'astrbot.log'))
          candidates.push(join(root, 'data', 'logs', 'astrbot.log.1'))
          let found = null
          for (const c of candidates) if (existsSync(c)) { found = c; break }
          if (!found) {
            let dirList = []
            try { dirList = await readdir(join(root, 'data', 'logs')) } catch (e) {}
            return {
              error: 'no log file found for root ' + root,
              tried: candidates,
              log_dir_entries: dirList,
              hint: cfg.ok && cfg.config.log_file_enable === false
                ? 'this instance has log_file_enable=false; either set it true (astrbot_api PUT /api/v1/configs) or use source=sse'
                : 'check the root, or use source=sse',
            }
          }
          const txt = await readFile(found, 'utf8').catch(function () { return '' })
          const all = String(txt).split(/\r?\n/).filter(keep)
          return {
            success: true,
            source: 'file',
            path: found,
            total_lines: String(txt).split(/\r?\n/).length,
            returned: Math.min(all.length, Number.isFinite(args.lines) ? args.lines : 120),
            log: all.slice(Math.max(0, all.length - (Number.isFinite(args.lines) ? args.lines : 120))).join('\n'),
          }
        }

        if (source === 'history') {
          const target = await resolveTarget(args)
          if (!target.base) return { error: target.error || 'no target instance' }
          const res = await apiCall(target, 'GET', '/api/v1/logs/history', undefined, {})
          return apiResult(res, 8000)
        }

        // sse
        const target = await resolveTarget(args)
        if (!target.base) return { error: target.error || 'no target instance' }
        const seconds = Number.isFinite(args.seconds) ? Math.max(1, Math.min(60, args.seconds)) : 5
        const headers = { Accept: 'text/event-stream' }
        if (target.jwtSecret) headers.Authorization = 'Bearer ' + mintJwt(target.jwtSecret, target.username || 'dsh').token
        const ac = new AbortController()
        const timer = setTimeout(function () { ac.abort() }, seconds * 1000 + 1500)
        const lines = []
        try {
          const res = await fetch(target.base + '/api/v1/logs/live', { headers, signal: ac.signal })
          if (!res.ok) {
            clearTimeout(timer)
            return { error: 'logs/live returned HTTP ' + res.status, base_url: target.base }
          }
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            const parts = buffer.split(/\r?\n/)
            buffer = parts.pop()
            for (const line of parts) {
              if (line.startsWith('data:')) {
                const payload = line.slice(5).trim()
                if (payload && payload !== '[DONE]' && keep(payload)) lines.push(payload)
              } else if (line.trim() && keep(line)) lines.push(line)
            }
          }
        } catch (e) {
          // abort 是预期的收尾方式
        } finally {
          clearTimeout(timer)
        }
        return {
          success: true,
          source: 'sse',
          base_url: target.base,
          seconds: seconds,
          count: lines.length,
          entries: lines.slice(-400),
          note: lines.length === 0 ? 'LogBroker 是内存 ring（上限 500 条）；插件里的 print() 不会进这里，只有 logger.* 会' : undefined,
        }
      },
    }),

    // ── 端到端注入 ───────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_chat',
      description: '★端到端功能验证：把一个 WebChat 会话里的用户消息注入真实事件流水线，等机器人回复。AstrBot 的 WebChatAdapter 是无条件启动的内置平台（core/platform/manager.py:96-102），所以不接任何真实平台也能跑通完整 pipeline，插件的 @filter.command / on_llm_request 等 hook 会正常触发。默认按对话框的 wake prefix 触发命令（默认字符串是 /），例如 message="/wb 看世界书"。返回拼接后的回复文本与原始事件流。',
      timeoutMs: 300000,
      properties: {
        message: { type: 'string', description: '要注入的消息文本（触发指令时记得带 wake prefix，默认 /）' },
        session_id: { type: 'string', description: '会话 ID，默认 astrbot-bridge-test（同一会话会累积上下文）' },
        root: { type: 'string', description: '实例数据根' },
        base_url: { type: 'string', description: 'dashboard 基址' },
        timeout_ms: { type: 'number', description: '等待回复的上限毫秒，默认 120000' },
        raw: { type: 'boolean', description: 'true 时把全部原始事件也返回' },
      },
      required: ['message'],
      async execute(args) {
        const message = String(args.message === undefined ? '' : args.message)
        if (!message) return { error: 'message is required' }
        const target = await resolveTarget(args)
        if (!target.base) return { error: target.error || 'no target instance' }
        if (!target.jwtSecret) {
          return {
            error: 'no jwt_secret for ' + target.base + '; cannot authenticate the websocket',
            hint: '确认 root 指向的实例有 data/cmd_config.json，或先 astrbot_start',
          }
        }
        const ready = await probeReady(target.base, 4000)
        if (!ready.ready) {
          return { error: 'instance at ' + target.base + ' is not answering (/api/v1/auth/setup-status)', probe_error: ready.error, hint: 'run astrbot_start first, or check astrbot_status' }
        }
        const token = mintJwt(target.jwtSecret, target.username || 'dsh').token
        const wsUrl = target.base.replace(/^http/, 'ws') + '/api/v1/unified-chat/ws?token=' + encodeURIComponent(token)
        const requestId = 'dsh-' + randomUUID()
        const sessionId = typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : 'astrbot-bridge-test'
        const started = Date.now()
        const result = await injectChat({
          url: wsUrl,
          timeoutMs: Number.isFinite(args.timeout_ms) ? args.timeout_ms : 120000,
          payload: {
            ct: 'chat',
            t: 'send',
            message_id: requestId,
            session_id: sessionId,
            message: [{ type: 'plain', text: message }],
          },
        })
        const out = {
          success: !result.error && !result.timed_out,
          base_url: target.base,
          session_id: sessionId,
          request_id: requestId,
          duration_ms: Date.now() - started,
          reply: result.reply || '',
          event_count: (result.events || []).length,
        }
        if (result.error) out.error = result.error
        if (result.error_code) out.error_code = result.error_code
        if (result.timed_out) {
          out.error = 'timed out waiting for the reply (got ' + (result.events || []).length + ' events)'
          out.hint = '若事件数是 0：确认实例在线且 token 有效；若有事件但无 end：看 astrbot_logs 是否插件抛异常'
        }
        if (args.raw) out.events = result.events
        else {
          out.events = (result.events || []).map(function (ev) {
            return compact({
              type: ev.type || ev.t,
              data: typeof ev.data === 'string' ? truncate(ev.data, 2000) : ev.data,
              streaming: ev.streaming,
            })
          })
        }
        return out
      },
    }),

    // ── 部署 ─────────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_deploy',
      description: '把本地插件开发目录同步进 AstrBot 实例的 data/plugins/<目录名>（先把原目录备份到 _plugin_backup/<名>_<时间戳>），然后可选地热重载。会自动跳过 .git/.build/__pycache__/node_modules/*.pyc。返回文件数、字节数与入口文件 md5，可与源码对拍确认真的拷进去了。',
      timeoutMs: 180000,
      properties: {
        source: { type: 'string', description: '本地插件开发目录（含 main.py 的那一层）' },
        plugin_name: { type: 'string', description: '目标目录名，默认取 source 的目录名' },
        root: { type: 'string', description: '实例数据根，默认受管实例或默认测试根' },
        reload: { type: 'boolean', description: '部署后是否立刻热重载，默认 true' },
        dry_run: { type: 'boolean', description: '只报告会做什么，不落盘' },
        keep_backup: { type: 'boolean', description: '是否保留备份，默认 true' },
      },
      required: ['source'],
      async execute(args) {
        const src = typeof args.source === 'string' && args.source.trim() ? resolve(args.source.trim()) : ''
        if (!src || !existsSync(src)) return { error: 'source does not exist: ' + (src || String(args.source)) }
        const name = typeof args.plugin_name === 'string' && args.plugin_name.trim()
          ? args.plugin_name.trim()
          : src.split(/[\\/]/).filter(Boolean).pop()
        const root = typeof args.root === 'string' && args.root.trim()
          ? resolve(args.root.trim())
          : (managed ? managed.root : defaultTestRoot())
        const pluginsDir = join(root, 'data', 'plugins')
        const dest = join(pluginsDir, name)
        const entry = detectEntryFile(src, name)
        const sizeInfo = await countTree(src)
        const srcHash = entry ? await hashFile(entry) : ''

        if (args.dry_run) {
          return {
            success: true, dry_run: true, source: src, dest: dest, plugin_name: name,
            entry_file: entry || undefined,
            would_copy: sizeInfo,
            dest_exists: existsSync(dest),
          }
        }
        if (!entry) {
          return {
            error: 'no entry file found in ' + src + ' (AstrBot discovers a plugin only when the directory holds main.py or <目录名>.py — star_manager.py:291-321)',
            expected: ['main.py', name + '.py'],
          }
        }

        await mkdir(pluginsDir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        let backupPath = ''
        if (existsSync(dest)) {
          backupPath = join(root, '_plugin_backup', name + '_' + stamp)
          await mkdir(dirname(backupPath), { recursive: true })
          try {
            await rename(dest, backupPath)
          } catch (e) {
            // 跨盘/被占用时退化成复制后删除
            await cp(dest, backupPath, { recursive: true, force: true })
            await rm(dest, { recursive: true, force: true })
          }
        }
        await cp(src, dest, {
          recursive: true,
          force: true,
          filter: function (s) { return !shouldSkip(s.split(/[\\/]/).pop(), null) },
        })
        const destEntry = detectEntryFile(dest, name)
        const destHash = destEntry ? await hashFile(destEntry) : ''
        const copied = await countTree(dest)

        let reloadResult = null
        if (args.reload !== false) {
          const target = await resolveTarget({ root: root })
          if (target.base && target.jwtSecret) {
            const res = await apiCall(target, 'POST', '/api/v1/plugins/reload', { plugin_id: name }, {})
            reloadResult = apiResult(res, 1000)
            reloadResult.reloaded = res.ok
            await sleep(1500)
            const failed = await apiCall(target, 'GET', '/api/v1/plugins/failed', undefined, {})
            const data = failed.ok && failed.json ? failed.json.data : null
            const list = Array.isArray(data) ? data : (data && (data.plugins || data.failed)) || []
            const hit = Array.isArray(list) ? list.find(function (p) {
              const n = p && (p.name || p.plugin_id || p.dir_name || p.id)
              return n === name
            }) : null
            reloadResult.failed = !!hit
            if (hit) reloadResult.failure = hit
          } else {
            reloadResult = { reloaded: false, error: target.error || 'instance not reachable; deploy only' }
          }
        }

        if (!args.keep_backup && backupPath) {
          try { await rm(backupPath, { recursive: true, force: true }) } catch (e) {}
          backupPath = ''
        }

        return {
          success: srcHash === destHash,
          source: src,
          dest: dest,
          plugin_name: name,
          entry_file: destEntry || undefined,
          entry_md5_source: srcHash || undefined,
          entry_md5_deployed: destHash || undefined,
          hash_match: srcHash === destHash,
          copied: copied,
          backup: backupPath || undefined,
          reload: reloadResult || undefined,
        }
      },
    }),

    // ── Python ───────────────────────────────────────────────────────────
    defineTool({
      name: 'astrbot_python',
      description: '用 AstrBot 自带的 CPython 解释器跑命令（默认 <安装根>/backend/python/python.exe）——那是本机唯一装齐 astrbot 依赖的解释器，系统 python 里没有。典型用法：args=["-m","pytest","-x","-q"] 跑插件自测，或 args=["-c","import astrbot; print(astrbot.__file__)"]。',
      timeoutMs: 600000,
      properties: {
        args: { type: 'array', description: '传给 python 的参数列表', items: { type: 'string' } },
        cwd: { type: 'string', description: '工作目录，通常是插件目录' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认 300000' },
        max_output: { type: 'number', description: 'stdout/stderr 各最多回多少字符，默认 8000' },
      },
      required: ['args'],
      async execute(args) {
        const list = Array.isArray(args.args) ? args.args.map(String) : []
        if (list.length === 0) return { error: 'args is required, e.g. ["-m","pytest","-x","-q"]' }
        const desktop = resolveDesktop()
        if (!desktop.ok) return { error: 'AstrBot desktop install not found', tried: desktop.tried }
        const python = pythonFor(desktop.shape.python)
        const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? resolve(args.cwd.trim()) : desktop.shape.install
        if (!existsSync(cwd)) return { error: 'cwd does not exist: ' + cwd }
        const timeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : 300000
        const ac = new AbortController()
        let handle
        try {
          handle = ctx.subprocess.spawn({
            argv: [python].concat(list),
            cwd: cwd,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 4 * 1024 * 1024 },
              stderr: { maxBytes: 4 * 1024 * 1024 },
            },
            graceMs: 3000,
            signal: ac.signal,
            env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
          })
        } catch (e) {
          return { error: 'failed to spawn python: ' + String((e && e.message) || e) }
        }
        let timedOut = false
        const timer = setTimeout(function () { timedOut = true; ac.abort(); try { handle.terminate() } catch (e) {} }, timeoutMs)
        let outcome = null
        try { outcome = await handle.done } catch (e) { outcome = { error: String((e && e.message) || e) } }
        clearTimeout(timer)
        const out = readCollected(handle, 'stdout', 0)
        const err = readCollected(handle, 'stderr', 0)
        const maxOut = Number.isFinite(args.max_output) ? args.max_output : 8000
        return {
          success: !timedOut && outcome && outcome.exitCode === 0,
          python: python,
          argv: list,
          cwd: cwd,
          exit_code: outcome ? outcome.exitCode : null,
          signal: outcome ? outcome.signal : null,
          timed_out: timedOut || undefined,
          stdout: truncate(out.text, maxOut),
          stderr: truncate(err.text, maxOut),
        }
      },
    }),
  ]

  // ── 常驻提示词 ──────────────────────────────────────────────────────────
  const systemPrompt = ctx.systemPrompt
  if (systemPrompt) {
    try {
      ctx.effect(function () {
        return systemPrompt.section({
          name: 'astrbot-plugin-dev:workflow',
          order: 150,
          text: 'ASTRBOT PLUGIN DEV PRESET — 本预设自带 astrbot_* 工具，用于开发/调试 AstrBot 插件。标准闭环：'
            + '① astrbot_status 看环境与实例；② 写/改插件代码；③ astrbot_deploy 部署进实例（自动备份 + md5 对拍 + 热重载）；'
            + '④ astrbot_reload / 看返回的 failed 字段确认没有导入期异常；⑤ astrbot_chat 注入一条消息做端到端功能验证（WebChat 是内置常驻平台，不需要接真实平台）；'
            + '⑥ astrbot_logs 看后端日志。改代码后不要重启 AstrBot：热重载是进程内「sys.modules 剔除 + 重新 import」，一次重载即生效（代价是模块级全局状态会丢）。'
            + '动手写插件前先加载 skill：astrbot-plugin-dev（开发规范与 API 全表）、astrbot-plugin-debug（启动/鉴权/验证通道）。',
        })
      })
      ctx.effect(function () {
        return systemPrompt.section({
          name: 'astrbot-plugin-dev:ownership',
          order: 151,
          text: 'ASTRBOT INSTANCE OWNERSHIP — 用户机器上通常有一个正在运行的 AstrBot 桌面实例（默认 dashboard 端口 6185）。'
            + 'astrbot_start 只会去起本插件管理的新实例，并且会主动避开已占用端口（默认 6186）；若某端口已有实例在应答，它会接管并返回 external:true，'
            + '此时 astrbot_stop 会拒绝终止它。绝不要用 shell 杀 AstrBot 进程（taskkill/Stop-Process 等）——桌面实例与桌面应用是同一个进程树。'
            + '要在隔离实例里验证插件，用 astrbot_start(root=...) + astrbot_deploy(...)，隔离实例会把所有平台 enable 关掉，避免抢线上账号与端口。',
        })
      })
      ctx.effect(function () {
        return systemPrompt.section({
          name: 'astrbot-plugin-dev:auth',
          order: 152,
          text: 'ASTRBOT AUTH — 不要试图登录 dashboard 拿 token（登录接口有限流，撞多了会被挡）。'
            + 'dashboard.jwt_secret 明文写在实例的 data/cmd_config.json 里，而鉴权链路只做 HS256 验签、不查库不校验密码，'
            + '所以 astrbot_token 直接本地自签 JWT 就能拿到等价管理员的凭据，astrbot_api / astrbot_reload / astrbot_chat 都已自动带上它。'
            + '要手写脚本时用 astrbot_token 取 token，或直接读那个文件（注意它是 UTF-8 带 BOM，必须按 utf-8-sig 解析）。',
        })
      })
    } catch (e) {}
  }

  // 插件停止时终结自己启动的进程；接管来的实例一律不动。
  ctx.effect(function () {
    return function () {
      if (managed && managed.handle) {
        try { managed.handle.terminate() } catch (e) {}
      }
      managed = null
    }
  })

  const tools = ctx.tools
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]
    ctx.effect(function () {
      try {
        return tools.register(def)
      } catch (e) {
        // 一个工具注册失败不能拖垮整个插件。
        try { ctx.logger.warn('[' + PKG + '] tool registration failed for ' + def.name + ': ' + String((e && e.message) || e)) } catch (e2) {}
        return function () {}
      }
    })
  }
}
