# dsh-astrbot-plugin-dev

给 DeepSeek Harness 用的 **AstrBot 插件开发预设**：一个预设（Agent Preset）、两个技能（Skill）、
十二个工具（Tool），合起来让 agent 既能**按 AstrBot 的真实规矩写插件**，又能**把 AstrBot 拉起来做功能检验**。

```
写代码 → 部署到实例 → 热重载 → 注入一条消息 → 看回复和日志 → 定位问题
```

整条链路都由 agent 自己完成，不需要人切窗口点按钮。

---

## 它解决什么问题

写 AstrBot 插件时，最容易浪费时间的不是业务逻辑，而是**看不见的约定**：

- 插件目录里没有 `main.py` → 插件被静默跳过（只有一行 info 日志）。
- `_conf_schema.json` 里写了个不支持的 `type` → 插件加载失败，且异常被吞成"加载失败"四个字。
- `@filter.llm_tool` 的参数漏了 docstring 类型 → import 期直接 ValueError。
- `Star.__init__` 不保存 config，`__del__` 和 `terminate()` 同时写就只有一个会跑。
- `event.send()` 要的是 `MessageChain` 不是字符串；`get_group_id()` 在私聊返回 `""`。
- 把数据写进插件目录，Windows 上插件更新会因文件占用失败到一半。

这些坑**单看报错根本推不出来**，因为大多数失败是静默的。本预设把这些知识做成常驻技能，
并且把"改完到底有没有生效"变成一条命令能回答的问题。

---

## 装了什么

### 1 个预设：`AstrBot 插件开发`（id: `astrbot-plugin-dev`，order 7）

预设本身 = 一套人格提示 + 工具集 + 压缩策略：

- **人格**里写死了工作流（先读现状 → 改代码 → 部署 → 热重载 → 注入验证 → 查日志）与六条铁律
  （验证一律用隔离实例、不碰用户正在跑的桌面实例、只用公开 API 面、日志必须走 `astrbot.api.logger`……）。
- **工具行** `astrbot-bridge` 只挂在这个预设里，其他预设（包括你日常写代码用的 standard）看不到
  `astrbot_*` 工具——避免无关会话被 12 个专用工具污染。
- **压缩阈值**调到 `thresholdChars: 32768 / headChars: 24576 / tailChars: 4096`
  （默认 8192）：调试插件时常要贴大段 traceback，默认阈值会把关键帧剪掉。

### 2 个技能

| 技能 | 什么时候用 | 内容 |
|---|---|---|
| `astrbot-plugin-dev` | 要写/改插件代码时 | SKILL.md 542 行：插件形态、装饰器速查、事件 API 全表、消息组件表、配置 schema、生命周期、Context/StarTools、**25 条硬性守则**；`references/cookbook.md` 14 个可照抄配方；`references/pitfalls.md` 30 条坑（现象→根因→修法）；`references/examples.md` 本机 15 个真实插件的索引与"该抄谁" |
| `astrbot-plugin-debug` | 要验证/排错时 | SKILL.md：实例与鉴权模型、验证剧本（含"假绿"陷阱）；`references/dashboard-api.md` 端点与 WS 协议实测表；`references/verification-playbook.md` 六种检验场景；`references/troubleshooting.md` 故障决策树 |

### 12 个工具

全部工具的参数都支持 `root` / `base_url` 覆盖，**不给就走三级回退**：
工具参数 → `$DSH_HOME/astrbot-plugin-dev.json` → profile 配置 → 自动探测。

| 工具 | 干什么 |
|---|---|
| `astrbot_status` | 总览：安装位置与版本、解释器、数据根、实例是否在线、dashboard 端口/用户名、jwt_secret 可读性、插件数与失败列表。**任何 AstrBot 工作前先跑它** |
| `astrbot_config` | 读/写本插件设置（`desktop_root` / `test_root` / `default_port` / `python_path`） |
| `astrbot_start` | 拉起一个**隔离的**受管实例：独立数据根、独立端口、从桌面配置复制一份但**关掉所有平台**（不抢线上账号/端口）、打开文件日志；已有人占端口就接管（`external: true`，绝不去杀） |
| `astrbot_stop` | 停掉**自己 spawn 的**实例（只认自己的 handle） |
| `astrbot_token` | 用实例自己的 `jwt_secret` 自签一枚 HS256 JWT（不走登录接口，避开 `auth_rate_limit`） |
| `astrbot_api` | 直连任意 dashboard 端点（默认自动带鉴权），用于查配置、拉清单、调 WebUI 有的接口 |
| `astrbot_plugins` | 插件清单 / **加载失败与 traceback** / 详情 / 运行时配置 / schema |
| `astrbot_reload` | 热重载一个插件，**并自动复查失败列表**（重载后若进了失败字典会直接报出来） |
| `astrbot_logs` | 日志三通道：`file`（读实例日志文件尾部）/ `history`（dashboard 历史）/ `sse`（连 live 流收集若干秒） |
| `astrbot_chat` | ★**端到端验证**：把一个 WebChat 会话的用户消息注入真实事件流水线，等机器人回复。WebChatAdapter 是无条件启动的内置平台，所以不接任何真实平台也能跑通完整 pipeline，插件的指令与 hook 会正常触发 |
| `astrbot_deploy` | 把开发目录同步进实例的 `data/plugins/<目录名>`（先备份到 `_plugin_backup/`，自动跳过 `.git`/`__pycache__`/`.build`），返回文件数、字节数与入口 md5 |
| `astrbot_python` | 用实例自己的解释器跑一段 Python（`D:\Program\AstrBot\backend\python\python.exe`，带全部依赖）——导入检查、跑插件自带测试都靠它 |

---

## 安装

```bash
# 1. 装进桌面 profile
"D:\Program\deepseek harness desktop\resources\runtime\cli\bin\dsh.cmd" \
  plugin --profile desktop add github:Nana7mi0721/astrbot-plugin-dev

# 2. 重启 DSH 桌面端（bundle 只在启动时建模块解析表，不重启会 ERR_MODULE_NOT_FOUND）
```

装完做两件事：

1. **把技能同步到一个稳定的技能根**（`customSkillDirs` 只认绝对路径，而且不能指向
   `node_modules` 里的装机副本——那是禁止修改的安装副本，bundle 一升级路径也可能变）：

   ```bat
   robocopy "E:\Study\github program\for dsh\astrbot-plugin-dev\skills" ^
            "%USERPROFILE%\.dsh\skills-astrbot-plugin-dev" /MIR /XD .git /XF env.local.json
   ```

   `cordis.patch.yml` 里已经写好这条路径（`C:/Users/REISEN/.dsh/skills-astrbot-plugin-dev`），
   换机或换 DSH 主目录时改那一行即可。同步一次之后，改 skill 只要重跑这条命令。

2. 切到该预设，说一句「检查 AstrBot 环境」，agent 会跑 `astrbot_status`。
   如果它说找不到安装，告诉它路径，或直接：

   ```
   astrbot_config(desktop_root="D:\\Program\\AstrBot")
   ```

---

## 首次使用：把链路跑通

在 `AstrBot 插件开发` 预设里依次说：

```
启动一个隔离的 AstrBot 实例
```

agent 会 `astrbot_start`（默认数据根 `~/.astrbot-test`、默认端口 6186，避开桌面实例的 6185）。
首次启动会从桌面实例复制 `cmd_config.json`（保留 provider 与密钥）、换掉端口、
把所有平台 `enable` 置 false、打开文件日志。

```
用 /help 试一下它响应不响应
```

agent 会 `astrbot_chat(message="/help")`——这条走的是完整事件流水线，
收到回复就说明实例、鉴权、pipeline 全通。

之后写插件、`astrbot_deploy`、`astrbot_reload`、再 `astrbot_chat("/你的指令")` 循环验证。

---

## 离线自测

```bash
npm test               # 纯离线：不需要 DSH、不需要 AstrBot、不联网（12 个用例）
npm run live           # 真机：真的拉起一个隔离 AstrBot 实例跑全链路（加 --clean 清空测试根重来）
npm run verify:schema  # 用**官方** defineTool 过一遍工具定义（要本机装了 DSH 桌面端；找不到就 SKIP）
```

`npm test` 用 `test/stub/` 里的 loader 钩子（`register.mjs` + `hooks.mjs`）把
`@deepseek-ai/schemastery` 和 `@deepseek-ai/dsh-tools` 换成最小替身，在 Node 里直接加载
`lib/index.js`，覆盖：

- 工具集合与 schema 结构（12 个，名字唯一，每项有 type + description）
- **官方 value schema 子集的静态等价检查**（见下）
- 配置三级回退与落盘
- volatile 字段的 `{ get() }` 形态（DSH ≥ 0.2 会把 volatile 冻结成引用）
- **自签 JWT 用独立实现的 HMAC 对拍**（签名、alg、payload、exp）
- 带 BOM 的 `cmd_config.json`
- 目标缺失 / 端口无实例时**返回 error 而不是抛异常**
- 可选服务（`configEditor`）缺席时插件照常工作（cordis 语义：依赖不满足就跳过回调，不是报错）
- 返回值的无损 JSON 契约（`undefined` / `NaN` / `-0` 会被 tool runtime 拒收；插件用
  `compact()` 提前剔掉常态缺省字段，`clean()` 兜底）
- 卸载时 disposer 可清理

`npm run live` 则真的拉起一个隔离实例（`~/.astrbot-test`、端口 6186）跑完九步：
定位桌面安装 → 启动 → 探测就绪 → 鉴权拉插件清单 → 查失败列表 → **注入 `/help` 收到回复** →
读日志文件 → 停机 → 确认端口不再应答。加 `--clean` 清空测试根重来。

`npm test` 曾经抓到过一个真 bug：`astrbot_config` 的返回值引用了 `if` 块内声明的变量，
一改设置就 `ReferenceError`，而工具的 try/catch 把它吞成了 `{ error: 'patchResult is not defined' }`
——**只看工具返回成功与否是发现不了的**，必须断言"不该有 error 字段"。

`npm run verify:schema` 抓到过**第二个、更凶的** bug：工具的 `parameters` 不是普通 JSON Schema，
而是官方 `@deepseek-ai/dsh-tools` 的 value schema DSL —— `type: 'object'` 必须**显式**带
`additionalProperties: true|false`，否则 `defineTool` 当场抛
`JsonSchemaError: parameters.body.additionalProperties must be explicitly true or false`。
`astrbot_api` 的 `body` 犯了这条，而 `test/stub/dsh-tools.mjs` 里的 `defineTool` 是恒等函数，
离线冒烟**根本看不见**——真机上会让整个预设起不来。修法：任意形状的 JSON 体改用 `type: 'json'`。
因为官方包被打进 Electron 的 `app.asar`（普通 node 读不到 asar），这个校验脚本会自己用
`ELECTRON_RUN_AS_NODE=1 <DeepSeek Harness.exe>` 重启一遍再跑；找不到 DSH 安装就 SKIP，不会红。

---

## 安全边界

- **绝不杀别人的进程。** `astrbot_stop` 只终止自己 `spawn` 的 handle；端口上已有人在应答时
  `astrbot_start` 直接接管并返回 `external: true`，不重复拉起、不 kill。
  桌面实例（`PID 14492` 那类）永远不碰。
- **隔离实例默认关掉所有平台**，所以不会拿你的 QQ/Telegram 账号真发消息。
- **鉴权不碰登录接口**：直接用实例自己的 `dashboard.jwt_secret` 自签 JWT。
  AstrBot 的验签链路只要求 `payload.username` 非空（不查库、不校验密码），
  自签等价于管理员——所以这个 secret 等于实例的最高权限，工具不会把它打到会话里
  （`astrbot_token` 只返回签好的 token，`astrbot_status` 只报 `jwt_secret_available: true/false`）。
- **部署前先备份**：`astrbot_deploy` 会把被覆盖的插件目录先移到 `_plugin_backup/<名>_<时间戳>`。

---

## 目录结构

```
astrbot-plugin-dev/
├── package.json            # bundle 元数据（dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml        # 预设行 + 工具行
├── lib/index.js            # 插件本体：12 个工具 + 3 段常驻 system prompt
├── skills/
│   ├── astrbot-plugin-dev/     # 写代码：规范 + 配方 + 坑 + 范例索引
│   └── astrbot-plugin-debug/   # 验证：端点表 + 剧本 + 排错树
└── test/
    ├── smoke.mjs           # 离线 12 用例（含官方 schema 子集的静态检查）
    ├── live.mjs            # 真机全链路
    ├── real-schema.mjs     # 官方 defineTool 校验（自动用 Electron-as-node 读 app.asar）
    └── stub/               # DSH 依赖的离线替身
```

---

## 已知边界

- **只在 Windows 桌面版 AstrBot 上验证过**（`D:\Program\AstrBot` 那套布局：`backend/python/python.exe`
  + `backend/launch_backend.py`）。`DESKTOP_CANDIDATES` 里另有两个默认路径，Linux/macOS 需要补探测规则。
- **`astrbot_start` 依赖 DSH 的 subprocess 服务**，所以在 DSH 之外跑（`npm run live`）用的是
  `test/live.mjs` 里 `node:child_process` 的替身。
- **`profile patch` 写回是尽力而为**：本插件的行嵌在预设的 `plugins:` 列表里，
  `configEditor.entries()` 未必寻址得到，所以设置以 `$DSH_HOME/astrbot-plugin-dev.json` 为准
  （这个文件永远写得进去）。
- **热重载不等于重启**：`_purge_modules()` 是删 `sys.modules` 后重 import，
  模块级全局状态会丢、插件实例会重建。要真重启请用 `astrbot_stop` + `astrbot_start`。
