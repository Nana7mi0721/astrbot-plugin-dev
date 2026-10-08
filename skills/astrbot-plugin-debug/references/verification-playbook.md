# 验证剧本：四种场景的可复制调用序列

每个剧本都是「调用序列 + 判定标准」。判定标准写死，**不要用"看起来对了"代替判定**。

---

## 剧本 A：新插件首次上线

**目标**：确认插件的文件形态、导入期、指令注册都真的通过了框架。

```
① astrbot_status(deep=true)
   判定：found=true；在线=true；jwt_secret 可读
   失败 → 先跑 astrbot_config(desktop_root="D:\\Program\\AstrBot")

② astrbot_start(port=6186)
   判定：ready=true；external=false（false 才说明是你自己起的隔离实例）
   若返回 external=true → 端口 6186 上有别的东西，换 6187

③ astrbot_deploy(source="E:\\...\\astrbot_plugin_xxx", reload=true)
   判定：copied > 0；返回的 md5 与本地 `md5sum main.py` 一致

④ astrbot_plugins(action="failed")
   ★判定：列表里**没有** astrbot_plugin_xxx
   有 → 读 error_trace，按 SKILL.md §4 决策树定位

⑤ astrbot_plugins(action="detail", plugin_id="astrbot_plugin_xxx")
   判定：能看到 version / author / 激活状态

⑥ astrbot_chat(message="/<你的指令>")
   ★判定：reply 里出现预期文本；且 stream 里有 type=end
```

**第⑥步没回复时的定位顺序**：
1. `astrbot_logs(filter="<插件名>", lines=200)` —— 有没有自己的 logger 输出？
2. 消息带 wake prefix 了吗？（`@filter.command` 受 `wake_prefix` 制约，默认 `/`）
3. `astrbot_plugins(action="config", plugin_id=...)` —— 配置是否为 `None`（`Star.__init__` 没存 config）？

---

## 剧本 B：改代码 → 热重载 → 复验

**目标**：最短回路，确认改动真的进了运行中的实例。

```
① astrbot_deploy(source="E:\\...\\astrbot_plugin_xxx", reload=true)
   判定：md5 与本地一致（**这一步是防"改了没拷进去"**）

② astrbot_plugins(action="failed")
   判定：不在失败列表

③ astrbot_logs(source="file", lines=80, filter="<插件名>")
   判定：出现重载后的新日志行
   （若插件在 initialize() 里打了一行版本号，这里最能确认"新代码在跑"）

④ astrbot_chat(message="/<触发指令>")
   判定：新行为生效
```

**注意热重载的真实语义**（决定你该改什么）：
- 是「从 `sys.modules` 剔除后重新 import」，**模块级全局变量会重置**。
- 插件实例重新构造 → `initialize()` 再跑一遍。
- 旧实例的 `terminate()` 会被调用。
- **没有自动热重载**，除非实例是以 `--reload` 启动的。

所以如果你的改动依赖模块级缓存，热重载后表现会与冷启动一致 —— 这是好事，
但如果你想验证"跨重载保持状态"，那本来就不该放在模块级。

---

## 剧本 C：LLM 链路（prompt 注入 / 工具调用）

**目标**：验证 `on_llm_request` 真的改到了请求、LLM 工具真的被模型调用了。

```
① 确认实例有可用的 provider
   astrbot_api(path="/api/v1/providers")    → 至少一个已配置的 provider

② astrbot_chat(message="随便说点什么", raw=true)
   ★判定：stream 里出现 type=plain 且 data 非空 → pipeline 通
   （这一步先证明"能回话"，再谈插件逻辑）

③ 若插件做 prompt 注入 / 工具注册，跑 astrbot_chat(message="/<你的指令>", raw=true)
   ★判定：raw 事件流里能看到
     - chain_type="tool_call" / "tool_call_result" 的帧 → 工具真被调了
     - 回复内容体现了注入效果
```

**`on_using_llm_tool` / `on_llm_tool_respond` 里抛异常会打断 agent loop。**
如果 `astrbot_chat` 在中途断掉（收到 `end` 但内容不全、或直接 error），
优先怀疑这两个钩子里没吞异常。

**`@filter.llm_tool` 的返回值语义**：返回 `str` → 结果并进下一轮 prompt；
返回 `None` → 对模型静默。验证时别把"模型没提这事"当成 bug。

---

## 剧本 D：Web API 与配置面板

**目标**：验证 `context.register_web_api` 注册的路由真的可访问、配置真的能读写。

```
① 路由可访问性
   astrbot_api(path="/api/plug/<你的路由>")     # ★ 对外前缀是 /api/plug
   判定：不是 404

② 配置读取
   astrbot_plugins(action="config", plugin_id="astrbot_plugin_xxx")
   判定：能看到运行时配置（对应 <root>/data/config/<目录名>_config.json）

③ schema 投影
   astrbot_plugins(action="schema", plugin_id="astrbot_plugin_xxx")
   判定：10 种合法 type 之外的类型会在这里/在 failed 列表里暴露

④ 写配置（可选）
   astrbot_api(method="PUT", path="/api/v1/plugins/config", body={...})
   然后 ② 复查
```

**常见误判**：`register_web_api(route="/xxx", ...)` 里的 `route` **不是**最终路径，
对外实际是 `/api/plug/xxx`（见 `core/star/context.py:705` 与 `astrbot/api/web.py`）。
直接访问 `/xxx` 会 404，别据此判定"没注册上"。

同 route + 同 methods 重复注册会**覆盖**前一个（不报错）—— 排查"路由成旧的了"时想这条。

---

## 通用纪律

1. **每一步都要有判定**。没有判定的调用只是"跑过了"，不是验证。
2. **md5 对拍**是防"改了没拷进去"的唯一手段 —— `astrbot_deploy` 会返回入口文件 md5。
3. **先证明 pipeline 通，再验证插件逻辑**。顺序反了会把框架问题误判成插件问题。
4. **失败先看 `failed` 列表，再看日志**。加载期异常不进日志红字。
5. `astrbot_chat` 默认会话 ID 固定（`astrbot-bridge-test`），**同一会话会累积上下文**；
   验证"无上下文时的行为"要显式换 `session_id`。
