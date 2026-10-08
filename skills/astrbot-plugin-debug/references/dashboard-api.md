# AstrBot Dashboard API 与 WebChat 注入协议

离开 `astrbot_*` 工具自己写脚本时看这份。全部来自 4.28.2 源码。

---

## 1. 环境变量（决定实例"是谁"）

| 变量 | 作用 | 源码 |
|---|---|---|
| `ASTRBOT_ROOT` | **唯一的隔离开关**。数据根 = `<ASTRBOT_ROOT>/data` | `core/utils/astrbot_path.py:29-35` |
| `ASTRBOT_DESKTOP_CLIENT` | 若为真且没设 `ASTRBOT_ROOT` → 数据根回落 `~/.astrbot` | 同上（`is_packaged_desktop_runtime()`） |
| `ASTRBOT_DESKTOP_MANAGED` | 同上，桌面端托管标志 | 同上 |
| `DASHBOARD_PORT` / `ASTRBOT_DASHBOARD_PORT` | dashboard 端口 | `dashboard/server.py:514-520` |
| `DASHBOARD_HOST` / `ASTRBOT_DASHBOARD_HOST` | dashboard 绑定地址 | 同上（`auth_service.py:486-490` 也读） |
| `ASTRBOT_BACKEND_STARTUP_HEARTBEAT_PATH` | 心跳文件路径（线程每 2s 写一次） | `backend/launch_backend.py` |
| `ASTRBOT_DESKTOP_CORE_LOCK_PATH` | 核心依赖锁文件（**是 pip 约束表，不是实例锁**） | `core/utils/desktop_core_lock.py:12,70,90` |

**起隔离实例时删掉 `ASTRBOT_DESKTOP_CLIENT` / `ASTRBOT_DESKTOP_MANAGED`**，
否则数据根会变成 `~/.astrbot`，隔离失败。

### 必须走 `launch_backend.py`

安装根的 `backend/launch_backend.py`（300 行）不是可有可无的包装，它做 6 件事：

1. `configure_stdio_utf8()` —— `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` + reconfigure stdout/stderr
2. `configure_windows_dll_search_path()` —— `os.add_dll_directory(python/、python/DLLs/、site-packages/cryptography.libs …)`
3. `preload_windows_runtime_dlls()`
4. `configure_windows_safe_default_ssl_context()`
5. `start_startup_heartbeat()` —— 写 `<heartbeat>` 文件，退出时写 state `"stopping"`
6. `configure_runtime_core_lock_path()` —— 设 `ASTRBOT_DESKTOP_CORE_LOCK_PATH`

最后 `sys.path.insert(0, APP_DIR)` + `runpy.run_path(app/main.py, run_name="__main__")`。
直接跑 `app/main.py` 会缺 DLL 路径 / SSL / UTF-8 处理。

---

## 2. 鉴权

### 2.1 自签 JWT（推荐）

- `dashboard/server.py:432-439` `_init_jwt_secret()`：`config["dashboard"]["jwt_secret"]` 不存在时
  用 `os.urandom(32).hex()` 生成并**写回配置**；随后 `dashboard/api/app.py:88,100` 把它挂到 `app.state.jwt_secret`。
- 也就是说 **secret 明文躺在 `<root>/data/cmd_config.json` 的 `dashboard.jwt_secret`** 里。
- 校验链路 `dashboard/api/auth.py:167-200` `require_scope()`：
  `jwt.decode(token, app.state.jwt_secret, algorithms=["HS256"])` →
  取 `payload["username"]`，非空字符串即通过 → `AuthContext(username=..., scopes=["*"], via="jwt")`。
  **不查库、不校验密码**。

所以自签一个 HS256 token，payload 里带 `username`，就等价于管理员：

```js
const header  = { alg: 'HS256', typ: 'JWT' };
const payload = { username: 'astrbot-bridge', exp: Math.floor(Date.now()/1000) + 604800 };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const body = `${b64(header)}.${b64(payload)}`;
const sig = require('node:crypto').createHmac('sha256', secret).update(body).digest('base64url');
const token = `${body}.${sig}`;
```

**不要走登录接口**：`auth_service` 有 `auth_rate_limit`（max_burst 3），撞限流就废。

### 2.2 token 的三种携带方式

`_extract_dashboard_jwt()`（`dashboard/api/auth.py:94-105`）只认两种：
`Authorization: Bearer <token>` 或 cookie（`DASHBOARD_JWT_COOKIE_NAME`）。
**WebSocket 例外** —— 从 query string 取：`?token=<jwt>`（见 §3）。

### 2.3 API Key（另一条路）

`_extract_raw_api_key()`（`dashboard/api/auth.py:67-78`）：
`Authorization: ApiKey <key>`、`?api_key=`、`?key=`、`X-API-Key` 四种任一。
API Key 走 scope 校验（`/api/v1/plugins/` 这类路由接受），部分 Open API 需要它。

---

## 3. WebChat WebSocket 注入协议 ★

这是**唯一**能在不接真实平台的情况下跑完整个事件流水线的通道。

### 3.1 连接

```
ws://127.0.0.1:6186/api/v1/unified-chat/ws?token=<JWT>
ws://127.0.0.1:6186/api/v1/live-chat/ws?token=<JWT>      # force_ct="live"
```

（legacy 无 `/v1`：`/api/unified_chat/ws`、`/api/live_chat/ws`）
见 `dashboard/api/live_chat.py:9-50`；token 从 `websocket.query_params.get("token")` 取。

### 3.2 鉴权与会话

`dashboard/services/live_chat_service.py:141-159`：

```python
def authenticate_token(self, token, jwt_secret=None) -> str:
    ...
    payload = jwt.decode(token, jwt_secret, algorithms=["HS256"])
    return payload["username"]          # ★ 缺 username 会 KeyError
def create_session(self, username: str) -> LiveChatSession:
    session_id = f"webchat_live!{username}!{uuid.uuid4()}"
```

失败时 `close(1008, str(exc))`，reason 是 `Missing authentication token` / `Token expired` / `Invalid token`。

### 3.3 发帧

外层 `ct` 默认 `"live"`（`unified-chat` 端点不强制），聊天必须显式 `"ct": "chat"`：

```json
{ "ct": "chat", "t": "send",
  "message_id": "<唯一，重复且未完成会报 Duplicate active message_id>",
  "session_id": "<可选，默认用连接自己的 session_id；给了就是另一条会话>",
  "message": [ { "type": "plain", "data": "消息文本" } ],
  "selected_provider": "...", "selected_model": "...",
  "persona_prompt": "...", "show_reasoning": false,
  "flags": { } }
```

另有 `{ "ct":"chat", "t":"bind", "session_id": "..." }` 用于绑定到一个已有会话。
`t` 不是 `send`/`bind` 就回 `Unsupported message type: <t>`。

### 3.4 错误帧（原样，便于 grep）

| `data` | 触发条件 |
|---|---|
| `message must be list` | `message` 字段不是数组 |
| `Message content is empty` | 各部分都没有实际内容 |
| `Duplicate active message_id` | 同 message_id 还有未完成的请求在跑 |
| `session_id is required` | `t:"bind"` 但没给 session_id |
| `Unsupported message type: <t>` | `t` 不是 send/bind |
| `处理失败: <exc>` | 处理过程中抛异常（`code: PROCESSING_ERROR`） |

错误帧形状：`{"ct":"chat","t":"error","data":...,"code":"INVALID_MESSAGE_FORMAT","message_id":...}`。

### 3.5 收帧

结果帧是 `{"ct":"chat", **result}`（`live_chat_service.py:700`），`result` 的键：

- `type`: `plain` / `image` / `record` / `file` / `video` / `agent_stats` / **`end`** / …
- `data`: 文本内容（image/record/file/video 时是文件名，带 `[IMAGE]`/`[RECORD]`/`[FILE]`/`[VIDEO]` 前缀）
- `streaming`: 是否流式片段
- `chain_type`: 可能为 `tool_call` / `tool_call_result` / `agent_stats`
- `message_id`: 回传，客户端**必须**按它关联

另外几种：`{"type":"session_bound"}`、`{"type":"message_saved","data":{id,created_at,llm_checkpoint_id}}`、
`{"type":"attachment_saved"}`、`{"type":"agent_stats","data":{...}}`。

**结束判定**：`if result_type == "end": break`（`live_chat_service.py:781-782`）。
所以客户端收到 `type === "end"` 就该收尾。

**流式累积的坑**：`streaming: true` 的 `plain` 片段**有时是累积快照、有时是增量**。
稳健做法：`if (msg.data.startsWith(acc)) acc = msg.data; else acc += msg.data;`。

### 3.6 为什么能用它做端到端验证

`core/platform/manager.py:96-102` **无条件**创建并启动 `WebChatAdapter`：

```python
self.platforms.append(WebChatAdapter({}, settings, event_queue))
await self._start_platform_task("webchat", ...)
```

WebChat 是内置平台，不需要任何账号配置。注进去的消息会真实走完
平台适配器 → 事件队列 → `star_manager` 分发 → 插件的 `@filter.command` /
`on_llm_request` / LLM 工具 → 结果回队列 → WS 回传。

---

## 4. Dashboard API 端点（插件开发常用的部分）

v1 前缀 `/api/v1`（`dashboard/api/router.py:38`）。**全部可用自签 JWT 访问。**

### 插件管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/plugins` | 已加载插件清单 |
| GET | `/api/v1/plugins/failed` | 加载失败列表 + traceback ★ |
| POST | `/api/v1/plugins/reload` | body `{"plugin_id": "<目录名>"}` ★ 热重载 |
| POST | `/api/v1/plugins/{id}/reload` | 同上（路径参数版） |
| POST | `/api/v1/plugins/failed/{id}/reload` | 重试加载失败的插件 |
| GET / PUT | `/api/v1/plugins/config` | 读/写插件配置 |
| PATCH | `/api/v1/plugins/enabled` | 启停插件 |
| GET | `/api/v1/plugins/{id}` | 插件详情 |
| GET | `/api/v1/plugins/{id}/config` | 该插件的运行时配置 |
| GET | `/api/v1/plugins/{id}/config/schema` | `_conf_schema.json` 投影 |

（`dashboard/api/plugins.py:424,678,720,735,837,850,916,958,970,1020,1104`）

### 就绪 / 日志 / 密钥

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/auth/setup-status` | ★**免鉴权**，就绪探测用它（HTTP <500 即在线） |
| GET | `/api/v1/logs/history` | 历史日志（`logs.py:66`） |
| GET | `/api/v1/logs/live` | SSE 实时日志（`logs.py:74`） |
| GET / POST | `/api/v1/api-keys` | 列出 / 创建 API Key（`api_keys.py:80,88`） |
| POST | `/api/chat/send` | **legacy**，SSE 版注入（`api/chat.py:316`），无 WS 时的备选 |

### 两套命名空间（别搞混）

- `/api/v1/plugins/...`（**复数**）—— 接受 API Key **或** JWT
- `/api/plugin/...`（**单数**）—— **只**接受 JWT；路径写死在 `dashboard/api/plugins.py:1207-1506`

---

## 5. 热重载的真实语义（决定你怎么验证）

`POST /api/v1/plugins/reload` → `PluginManager.reload()`（`core/star/star_manager.py:1015-1071`）：

```
_pm_lock 上锁
  → _terminate_plugin()       # 调 terminate()（若同时定义了 __del__ 则只调 __del__）
  → _unbind_plugin()          # del star_map；摘 handler 与 star_handlers_map；
                              # 摘 llm_tools.func_list；注销平台适配器
  → _purge_modules()          # ★ 把该插件的全部模块从 sys.modules 删除
  → load()                    # 重新 import（不是 importlib.reload）
```

**推论**：

1. 改完代码调一次 reload 就生效，**不需要重启进程**。
2. 模块级全局状态（缓存、单例、连接池）**全部丢失**。
3. 插件实例会**重新构造**，`initialize()` 会再跑一遍。
4. 前一个实例的 `terminate()` 会被调用 —— 资源清理写在那里才有意义。
5. 若插件在插件目录里持有文件句柄（SQLite/FAISS/日志），会挡住插件**更新**
   （Windows `WinError 32`）。

自动热重载（watchfiles）**只在 `ASTRBOT_RELOAD=1` 时启用**
（`core/star/star_manager.py:222`，来自 `cli/commands/cmd_run.py:58 --reload`）。
真正的进程重启是另一条路：`core/process_restart.py`。
