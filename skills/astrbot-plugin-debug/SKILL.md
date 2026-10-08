---
name: astrbot-plugin-debug
description: 启动/接管 AstrBot 实例、把插件部署进实例、热重载、注入真实消息做端到端功能检验、读运行日志、排查插件加载或运行故障时使用。配合 astrbot_* 工具（astrbot_status / astrbot_start / astrbot_deploy / astrbot_reload / astrbot_plugins / astrbot_logs / astrbot_chat 等）。只要任务涉及"跑起来看看""验证插件生效""插件加载失败了"，就读这份。
---

# AstrBot 实盘调试

AstrBot 插件**不能在框架外验证**。装饰器注册、事件分发、LLM 流水线、配置面板、
热重载语义，全都依赖真实的 star_manager / 事件队列。所以"我觉得对"不算验证 ——
必须把一个真实实例跑起来，把消息注进去，看回复和日志。

## §0 铁律

1. **绝不终止用户正在跑的实例**。用户桌面端的 AstrBot 通常已占用 `6185`（dashboard）
   和 `8082`（WebUI）。杀了它会连桌面应用一起带走。
   `astrbot_start` 检测到端口已有应答时会**接管**它并返回 `external: true`；
   `astrbot_stop` 对这类实例会**拒绝**执行 —— 这是有意的。
2. **隔离实例必须改端口**。默认用 `6186`，并且把 `cmd_config.json` 里所有
   `platform[].enable` 置 `false` —— 否则测试实例会去抢真实平台端口、
   甚至用你的账号往真实群里发消息。
3. **`print()` 不进日志通道**。插件里只有 `from astrbot.api import logger` 的输出
   才会出现在 `astrbot_logs` 里。调试时不要用 print。

---

## §1 两个实例的拓扑

| | 桌面实例 | 隔离测试实例 |
|---|---|---|
| 谁在跑 | 用户的 `astrbot-desktop-tauri.exe` | 本插件 `astrbot_start` spawn 的 |
| 数据根 (`ASTRBOT_ROOT`) | `D:\Program\AstrBot\AstrBotData` | 默认 `~/.astrbot-test`（可改） |
| dashboard 端口 | 6185 | 6186（避开 6185） |
| 平台 | 用户真实配置（QQ/微信…） | 全部 `enable: false` |
| 插件来源 | 用户自己的插件目录 | 你 `astrbot_deploy` 拷进去的那份 |
| 能不能杀 | **不能** | 能（`astrbot_stop`） |

隔离实例首次启动时会从桌面实例 `cmd_config.json` **复制一份**再改
（保留 provider / API key，这样 LLM 相关插件能真跑），改完的项：
`dashboard.host/port`、所有 `platform[].enable=false`、
`log_file_enable=true` + 日志指向 `<root>/data/logs/astrbot.log`、`disable_metrics=true`。

启动命令走的是 `<安装根>/backend/launch_backend.py`，**不是** `app/main.py` ——
前者负责 UTF-8 stdio、Windows DLL 搜索路径、SSL、启动心跳、core lock，
少了任何一项都会出怪问题（详见 `references/dashboard-api.md` §1）。

---

## §2 标准验证流程

改完插件代码后照这个顺序走，**每一步都有明确判定**，不要跳步。

```
① astrbot_status(deep=true)          → 确认能找到安装、实例在线、jwt_secret 可读
② astrbot_deploy(source=<插件目录>)   → 拷进实例 + 自动热重载，返回入口文件 md5
③ astrbot_plugins(action="failed")   → ★判定：目标插件不在失败列表里
④ astrbot_chat(message="/你的指令")   → ★判定：回复里出现预期文本
⑤ astrbot_logs(filter="<你的插件名>") → ★判定：有自己的 logger 输出、无 Traceback
```

### 为什么第③步不能省

AstrBot 的插件加载把导入异常吞进了 `failed_plugin_dict`
（`core/star/star_manager.py:1432-1448` 的 `except BaseException`）。
**症状是"插件没反应"，不是报错红字**。
所以「没红字」不等于「加载成功」—— 必须显式查 failed 列表。

### 为什么第④步能用 WebChat

`core/platform/manager.py:96-102` **无条件**启动 `WebChatAdapter`：
不接任何真实平台，事件流水线也是完整的。所以 `astrbot_chat` 注入的消息会
真实地走完 平台适配器 → 事件队列 → star 分发 → 你的 handler → 结果回传，
`@filter.command` / `on_llm_request` / `llm_tool` 全部会正常触发。

触发指令时**必须带 wake prefix**（默认 `/`）。`@filter.command` 受 wake_prefix 制约，
`@filter.regex` 不受 —— 如果注入的消息没反应，先确认这个。

---

## §3 鉴权

Dashboard API 需要 JWT。**不要走登录接口**（`auth_rate_limit` max_burst=3，撞限流就废）。

正确做法：读实例的 `<root>/data/cmd_config.json`，取里面**明文**的
`dashboard.jwt_secret`，用 HS256 自签一个 token。鉴权链路只验签、不查库不校验密码
（`dashboard/api/auth.py:167-200 require_scope()` 解出 `payload["username"]` 非空即通过），
所以自签 token 等价于管理员。secret 的来源是 `dashboard/server.py:432-439 _init_jwt_secret()`
——配置里没有时它会 `os.urandom(32).hex()` 生成并写回配置。

`astrbot_token` 就是干这个的；`astrbot_api` / `astrbot_plugins` / `astrbot_chat`
默认自动带上它。需要手工 curl 时：

```
astrbot_token()            → 拿到 token
curl -H "Authorization: Bearer <token>" http://127.0.0.1:6186/api/v1/plugins
```

注意 `cmd_config.json` 是 **UTF-8 with BOM**，解析前要剥掉 `\uFEFF`。

**两套命名空间别搞混**：
- `/api/v1/plugins/...`（复数）—— 接受 API Key **或** JWT
- `/api/plugin/...`（单数）—— **只**接受 JWT

---

## §4 故障排查决策树

```
插件没反应
├─ astrbot_plugins(action="failed") 里有它？
│   ├─ 有 → 看 error_trace
│   │   ├─ "不受支持的配置类型"  → _conf_schema.json 有非法 type（只允许 10 种）
│   │   ├─ "缺少类型注释"        → @filter.llm_tool 的 docstring Args: 没写类型
│   │   ├─ SyntaxError/ImportError → 直接读 traceback
│   │   └─ 其它 → 见 references/troubleshooting.md
│   └─ 没有 → 进下一层
├─ astrbot_plugins(action="list") 里有它？
│   ├─ 没有 → 目录里没有 main.py（发现规则会静默跳过）
│   └─ 有 → 进下一层
├─ 指令没触发？
│   ├─ 消息带 wake prefix 了吗（默认 /）
│   ├─ 用的是 @filter.command（受 wake_prefix 制约）还是 @filter.regex（不受）
│   └─ @filter.event_message_type / permission_type 把事件过滤掉了？
└─ 触发了但没输出？
    ├─ yield 了吗（handler 必须是 async generator 才能 yield result）
    ├─ 结果被 .use_t2i(True) 渲染成图了？
    └─ stop_event() 把 result 一起吃掉了？（clear_result 才是只丢结果）
```

**任何时候卡住，先跑 `astrbot_status(deep=true)` + `astrbot_plugins(action="failed")`。**

---

## §5 工具速查

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `astrbot_status` | 环境+实例总览；**开工第一步** | `deep=true` 拉插件清单与失败详情 |
| `astrbot_start` | 起隔离实例 / 接管已有实例 | `port`（默认 6186）、`root`、`wait_ms` |
| `astrbot_stop` | 停自己起的实例（对 external 会拒绝） | — |
| `astrbot_deploy` | 源码目录 → 实例 `data/plugins/`，自动备份+重载 | `source`、`reload`、`dry_run` |
| `astrbot_reload` | 热重载单个插件并复查失败列表 | `plugin_id` |
| `astrbot_plugins` | list / failed / detail / config / schema | `action`、`plugin_id` |
| `astrbot_logs` | 取日志（file / sse / history） | `source`、`lines`、`filter` |
| `astrbot_chat` | ★端到端注入消息并等回复 | `message`、`session_id`、`timeout_ms` |
| `astrbot_api` | 带鉴权打任意 dashboard 路由 | `method`、`path`、`body`、`auth` |
| `astrbot_token` | 自签 dashboard JWT | `ttl_seconds` |
| `astrbot_python` | 用 AstrBot 自带解释器跑命令/测试 | `args`、`cwd` |
| `astrbot_config` | 写本插件自己的设置（安装根/端口/解释器） | `desktop_root`、`test_root`、`default_port` |

**`astrbot_python` 很重要**：本机**只有** `<安装根>/backend/python/python.exe`
装了 astrbot 依赖，系统 python 里没有。要在插件目录里跑 pytest 只能用这个解释器。

---

## §6 参考文件

- `references/dashboard-api.md` —— 端点全表、WebSocket 注入协议（帧格式/错误串/结束语义）、
  环境变量表、鉴权链路细节。要脱离 `astrbot_*` 工具自己写脚本时读它。
- `references/verification-playbook.md` —— 四种具体剧本（新插件首装 / 改代码热重载 /
  LLM 工具链路 / Web API 与配置面板），每个剧本给出**可直接复制的调用序列**与判定标准。
- `references/troubleshooting.md` —— 故障现象 → 根因 → 处置 的对照表，
  含隔离实例启动失败、端口占用、日志不落盘、LLM 不回话等。
