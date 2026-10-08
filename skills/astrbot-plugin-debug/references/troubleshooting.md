# 故障对照表：现象 → 根因 → 处置

按现象查。每条都给了判定手段，**不要靠猜**。

---

## 一、环境与实例

### 「找不到 AstrBot 安装」

- **现象**：`astrbot_status` 报 `found: false`。
- **判定**：安装根必须**同时**含 `backend/python/python.exe` 与 `backend/app/`。
- **处置**：`astrbot_config(desktop_root="D:\\Program\\AstrBot")`。
- **注意**：数据根（`AstrBotData`）与安装根是**两层**。传错层会探测失败。

### 起了实例但探测不到 / `ready: false`

排查顺序：

1. **端口被占**：`astrbot_status` 会报端口占用。桌面实例固定 6185，
   隔离实例用 6186+；换一个端口再试。
2. **数据根错了**：若没删环境里的 `ASTRBOT_DESKTOP_CLIENT` / `ASTRBOT_DESKTOP_MANAGED`，
   数据根会回落 `~/.astrbot`，实例在一个你没预期的目录里跑起来。
3. **直接跑了 `app/main.py`**：缺 DLL 搜索路径 / SSL / UTF-8 处理，可能静默失败。
   必须走 `backend/launch_backend.py`。
4. **端口冲突是硬失败**：AstrBot 发现配置端口被占会直接 `raise`，不会自动换端口。
   所以隔离实例的 `cmd_config.json` 里 `dashboard.port` 必须改掉。

### 「实例是 external，停不掉」

- **这不是 bug**。`external: true` 表示端口上已经有实例在应答（通常是用户桌面端跑的），
  插件**接管**了它而不会去杀它。`astrbot_stop` 对它一律拒绝。
- **处置**：要停就让用户在桌面端退出；要自己起就 `astrbot_start(port=6187)` 换个端口。

### 中文乱码 / `UnicodeEncodeError`

- **根因**：没走 `launch_backend.py` 的 `configure_stdio_utf8()`（设 `PYTHONUTF8=1`、
  `PYTHONIOENCODING=utf-8` 并 reconfigure stdout/stderr）。
- **附带**：`cmd_config.json` 是 **UTF-8 with BOM**，自己解析要先剥 `\uFEFF`。

---

## 二、插件加载

### 「插件没反应，日志也没红字」

- **根因**：加载期异常被 `except BaseException` 吞进 `failed_plugin_dict`
  （`core/star/star_manager.py:1432-1448`）。**"没红字"不等于"加载成功"。**
- **处置**：`astrbot_plugins(action="failed")` —— 这是唯一可靠的判定。

### 「failed 列表里根本没有我的插件」

- **根因**：目录里既没有 `main.py` 也没有 `<目录名>.py`，被
  `star_manager.py:291-321` **静默跳过**（只打一行 `info`）。
- **处置**：确认入口文件名。

### `不受支持的配置类型 <x>`

- **根因**：`_conf_schema.json` 用了 10 种之外的 type
  （`core/config/astrbot_config.py:151-154` 直接 `raise TypeError`，被上层吞掉）。
- **合法 10 种**：`int float bool string text list file object template_list dict`
- **处置**：改 type；改完必须重查 `failed`。

### `LLM 函数工具 xxx 的参数 yyy 缺少类型注释`

- **根因**：`@filter.llm_tool` 的参数类型**只**从 docstring 的 `Args:` 解析
  （`core/star/register/star_handler.py:638-641`）。
- **处置**：`Args:` 里写成 `name(type): 说明`；`event` 参数不要写进 `Args`。

### `AstrBot 4.28.2 does not satisfy plugin astrbot_version: v4.28.2`

- **根因**：`astrbot_version` 写成了裸版本号，框架用 `SpecifierSet` 解析。
- **处置**：改写成 PEP 440 区间，如 `">=4.16,<5"`。

### `Missing required fields` / `必须是非空字符串`

- **根因**：`metadata.yaml` 缺 `name`/`desc`/`version`/`author` 之一
  （`core/star/updater.py:26,379-393`）。
- **附带**：`metadata.yaml` 超过 1MB 也会抛错。

---

## 三、运行期

### 「指令发了没反应」

逐条排除：

1. **wake prefix**：`@filter.command` 受 `wake_prefix` 制约（默认 `/`）。
   `@filter.regex` **不受**。用 `astrbot_chat(message="/指令")`。
2. **筛选器**：`@filter.event_message_type(...)` / `permission_type(...)` 把事件过滤了？
   WebChat 注入的事件是私聊、`role="member"`。
3. **handler 不是 async generator**：想 `yield` 结果就必须 `async def` + `yield`；
   写成普通 `async def` + `return` 不会发出任何东西。
4. **`stop_event()` 吃掉了结果**：`stop_event()`（`astr_message_event.py:348`）
   置 `_force_stopped=True` **并连带**处理已有 result；
   只想丢弃自己刚 yield 的结果用 `clear_result()`（L383）。
5. **`.use_t2i(True)`**：长文本被渲染成图片，客户端收到的不是文本。
   真实插件普遍统一 `.use_t2i(False)`。

### 「日志里看不到我的输出」

- **根因**：插件里的 `print()` **不进**日志通道。只有
  `from astrbot.api import logger` 的输出才会被收集。
- **附带**：logger 会按调用方模块自动路由到 `astrbot.plugin.<插件名>`，
  所以 `astrbot_logs(filter="<插件名>")` 能精确过滤。
- **文件日志没内容**：检查实例配置里 `log_file_enable` 是否为 true，
  以及日志文件路径（隔离实例默认 `<root>/data/logs/astrbot.log`）。

### 「热重载了但行为没变」

1. **确认真的拷进去了**：`astrbot_deploy` 返回的入口文件 md5 vs 本地 md5。
2. **确认 reload 成功**：`astrbot_plugins(action="failed")` 里有没有它。
3. **确认改的不是"只在构造期读一次"的东西**：重载会重建实例、重跑 `initialize()`，
   但**模块级全局变量会重置**（`_purge_modules()` 是删 `sys.modules` 后重 import）。
4. **Python 字节码缓存**：`__pycache__` 里若有陈旧 `.pyc` 且 mtime 异常，可能加载旧代码。
   `astrbot_deploy` 默认跳过 `__pycache__`，必要时手工删实例里的 `__pycache__`。

### 「更新插件失败 / `WinError 32`」

- **根因**：插件把运行时数据（SQLite / FAISS / 日志）写在自己的插件目录里，
  更新器解压前要 `remove_dir(plugin_path)`，文件被占用 → 删除失败 → 更新装一半。
- **处置**：把数据搬到 `StarTools.get_data_dir()`（= `data/plugin_data/<插件名>`）。
  迁移时连带 `-wal` / `-shm` / `-journal` 一起搬。

### 「事件循环卡住几秒」

- **根因**：在事件循环里做了同步 IO。典型元凶：
  `Comp.File.file`（`components.py:776-798`）与 `Image.convert_to_file_path()`
  会在"有 URL 无本地文件"时**同步下载**，并打 warning「请使用 await get_file()」。
- **处置**：用 `await comp.get_file()`；配置落盘用 `save_config_async()`
  （内部走 `asyncio.to_thread`）；任何阻塞调用都丢线程池。

---

## 四、WebChat 注入

### WebSocket 立刻断开，close code 1008

reason 直接告诉你原因：

| reason | 处置 |
|---|---|
| `Missing authentication token` | URL 上加 `?token=<jwt>`（**query string**，不是 header） |
| `Invalid token` | token 不是用该实例的 `dashboard.jwt_secret` 签的，或 payload 缺 `username` |
| `Token expired` | 重签一个（默认给 7 天） |

### `Duplicate active message_id`

- 同一个 `message_id` 上一个请求还没结束。每次发送用新的 id（uuid）。

### `Message content is empty`

- `message` 数组里的部件没有实际内容。最小可用：
  `[{"type":"plain","data":"文本"}]`。

### 「收不到回复，但连接没断」

1. `type === "end"` 才是结束；确认你在等的是它。
2. **流式片段有累积/增量两种形态**，只做追加会得到重复文本；
   用 `if (data.startsWith(acc)) acc = data; else acc += data;`。
3. 检查 LLM provider 是否配置可用：`astrbot_api(path="/api/v1/providers")`。
4. `astrbot_chat` 有超时上限（默认 120s）—— 慢模型要调 `timeout_ms`。

### 没有全局 `WebSocket`（Node < 22）

- Node 22+ 才有全局 `WebSocket`。低版本要么升级，要么换
  `POST /api/chat/send`（legacy SSE 通道，`dashboard/api/chat.py:316`）。

---

## 五、通用

### 「系统 python 里没有 astrbot」

- **必然如此**。本机**只有** `<安装根>/backend/python/python.exe` 装了 astrbot 依赖。
- **处置**：跑插件自测/脚本一律用 `astrbot_python(cwd=<插件目录>, args=["-m","pytest","-x","-q"])`。

### 「token 拿到了但接口 401/403」

- 401：token 不属于这个实例（secret 不同）或过期。
- 403 `Insufficient API key scope`：你走的是 API Key 路径，scope 不够。
- 注意两套命名空间：`/api/v1/plugins/`（复数，Key 或 JWT）vs `/api/plugin/`（单数，**只** JWT）。

### 排查时的信息采集顺序

```
astrbot_status(deep=true)                     # 环境 + 实例 + 插件概况
astrbot_plugins(action="failed")              # ★ 加载失败（最常被忽略）
astrbot_logs(source="file", lines=200, filter="<插件名>")
astrbot_logs(source="file", lines=200, filter="Traceback")   # 深挖异常
astrbot_python(args=["-c", "import astrbot; print(astrbot.__file__)"])  # 环境自检
```
