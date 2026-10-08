# AstrBot 插件开发：坑清单（现象 → 根因 → 修法）

全部来自 4.28.x 源码核对与真实插件的线上事故。**写代码前扫一遍**，
因为下面大多数坑的失败方式是「静默」或「表现成别的问题」。

---

## A. 加载期静默失败（最难查的一类）

### A1. 插件目录里没有 `main.py` → 插件被静默跳过

- **现象**：插件列表里根本没有这个插件，日志里只有一行 `info`。
- **根因**：`core/star/star_manager.py:291-321` —— 目录内必须有 `main.py`，
  否则退而找 `<目录名>.py`；都没有就 `logger.info(f"Plugin {d} has neither main.py nor {d}.py; skipping it.")`。
  模块路径固定 `data.plugins.<目录名>.main`。
- **修法**：入口文件必须叫 `main.py`（或与目录同名）。

### A2. `_conf_schema.json` 里写了非法 type → 整个插件加载失败

- **现象**：插件"加载失败"，但日志里未必有明显的 schema 报错。
- **根因**：`core/config/astrbot_config.py:151-154` 对未知 type 直接
  `raise TypeError(f"不受支持的配置类型 {v['type']}。支持的类型有：{DEFAULT_VALUE_MAP.keys()}")`，
  而这个异常被加载流程的 `except BaseException` 吞掉，只表现成"加载失败"。
- **修法**：type 只用 `int float bool string text list file object template_list dict`
  （`core/config/default.py:4794-4805`）。改完先看 `astrbot_plugins(action="failed")`。

### A3. `@filter.llm_tool` 的业务参数缺类型注释 → 导入即 ValueError

- **现象**：插件加载失败，traceback 指向 `register/star_handler.py`。
- **根因**：`register/star_handler.py:638-641`：参数类型**只**从 docstring 的 `Args:` 解析，
  缺失就 `raise ValueError(f"LLM 函数工具 …_的参数 {arg.arg_name} 缺少类型注释。")`；
  不支持的类型（`register/star_handler.py:653-655`）同样抛错。
- **修法**：每个业务参数在 `Args:` 里写成 `name(type): 说明`；`event` 参数**不要**写进 `Args`。

### A4. `metadata.yaml` 四字段缺失

- **现象**：`Missing required fields` / `必须是非空字符串`。
- **根因**：`core/star/updater.py:26` `PLUGIN_METADATA_REQUIRED_FIELDS = ("name","desc","version","author")`，
  校验在 `updater.py:379-393`；文件 >1MB 也抛错。
- **修法**：四个字段都写非空字符串。

### A5. `astrbot_version` 写成裸版本号

- **现象**：`AstrBot 4.28.2 does not satisfy plugin astrbot_version: v4.28.2`。
- **根因**：`star_manager.py:671-703` 用 `SpecifierSet(normalized_spec).contains(VERSION, prereleases=True)`。
- **修法**：写 PEP 440 区间，如 `">=4.16,<5"`。

### A6. import 期异常被吞进 `failed_plugin_dict`

- **现象**：插件不工作，但主进程活着、也没有红字。
- **根因**：`star_manager.py:1432-1448` 的 `except BaseException` 把导入异常隔离掉，
  只记进 `failed_plugin_dict`，最后 `return False, self.failed_plugin_info`。
- **修法**：改完代码**永远先看 `astrbot_plugins(action="failed")`**，不要靠日志红字判断。

---

## B. 生命周期陷阱

### B1. 同时定义 `__del__` 和 `terminate()` → `terminate()` 永不执行

- **根因**：`star_manager.py:1928-1976` 的逻辑是
  `if "__del__" in cls.__dict__: run_in_executor(None, cls.__del__) elif "terminate" in cls.__dict__: await cls.terminate()`。
- **后果**：后台任务、DB 连接、socket 都不会被清理，热重载几次就泄漏一批。
- **修法**：只写 `terminate()`，`__del__` 一个字母都不要出现（它是已废弃 API）。

### B2. 把热重载当重启

- **根因**：`_purge_modules()`（`star_manager.py:739-771`）是把插件模块从 `sys.modules`
  **删除后重新 import**，不是 `importlib.reload`。
- **后果**：模块级全局状态（缓存 dict、连接池、单例标志位）全部丢失；
  插件实例重建、`initialize()` 再跑一遍；前一个实例的 `terminate()` 会先被调用。
- **修法**：状态放实例属性或 `StarTools.get_data_dir()` 下的文件；不要在模块顶层持有跨重载状态。

### B3. `initialize()` 里做重活导致加载超时

- **根因**：`star_manager.py:1419-1421` 是 `await cls.initialize()`，阻塞整个加载流程。
- **修法**：把耗时初始化拆成后台 task，在 `initialize()` 里只 `create_task`。

### B4. 不取消后台任务 → 孤儿任务

- **根因**：重载时旧实例 `terminate()` 被调用，但 asyncio task 不会被自动取消。
- **修法**：`terminate()` 里 `task.cancel()` + `await task`。

---

## C. 事件与消息

### C1. `Star.__init__` 不保存 config

- **现象**：`self.config` 是 `None` 或 AttributeError。
- **根因**：`core/star/base.py:19-28` 的 `__init__(self, context, config=None)` 只存 `context`。
- **修法**：`self.config = config or {}`。

### C2. `await event.send()` 传字符串

- **根因**：`astr_message_event.py:483` 的签名是 `send(message: MessageChain)`。
- **修法**：`await event.send(MessageChain().message("文本"))`，或用 `event.plain_result()` + `yield`。

### C3. `stop_event()` 与 `clear_result()` 混用

- **根因**：`stop_event()`（L348）置 `_force_stopped=True` 并**连带**处理已有 result（终止事件传播）；
  `clear_result()`（L383）只是把已经产出的结果丢掉，事件继续传播。
- **后果**：以为"拦住了"，其实消息还是发出去了（或反过来）。
- **修法**：要拦截/终止用 `stop_event()`；只是想撤销自己刚 yield 的结果用 `clear_result()`。

### C4. `get_group_id()` 在私聊返回 `""`

- **根因**：`astr_message_event.py:195`。
- **修法**：会话键一律用 `event.unified_msg_origin`（格式 `平台名:消息类型:会话ID`），
  不要用 `get_group_id()` 或 `sender_id` 当唯一键。

### C5. UMO 平台名对不上 → 主动推送静默失败

- **根因**：`context.send_message`（`context.py:614`）按 `platform.meta().id == session.platform_name`
  查平台，找不到**只 warning、返回 False**。
- **修法**：先 `event.get_platform_name()` / `event.unified_msg_origin` 拿到真实值，别手拼。

### C6. 图片/文件类字段在事件循环里同步下载

- **根因**：`Comp.File.file`（`components.py:776-798`）与 `Image.convert_to_file_path()`
  在"有 URL 无本地文件"时会**同步**下载，并打 warning「请使用 await get_file()」。
- **后果**：整个 bot 卡住几秒到几十秒（所有会话）。
- **修法**：用 `await comp.get_file()` / `Comp.Image.fromURL()`；任何网络 IO 都别在属性访问里做。

---

## D. LLM / Agent

### D1. llm_tool 返回 `None` → 模型什么都看不到

- **根因**：`register/star_handler.py:604-608`：只有返回 `str` 才会把结果并进下一轮 prompt。
- **修法**：想"静默"就用 `None`（这是有意设计），想给模型信息就返回字符串。

### D2. `on_using_llm_tool` / `on_llm_tool_respond` 抛异常 → 打断 agent loop

- **根因**：这两个 hook 在工具调用链中间执行，异常会冒泡到 agent loop。
- **修法**：整个 body 包 try/except，出错就降级放行（真实插件 `astrbot_plugin_quillplus`
  就是 `on_using_llm_tool` 吞异常、`on_llm_request` 不吞的分层策略）。

### D3. 在 `on_llm_request` 之外改请求

- **根因**：`@filter.on_llm_request()`（`star_handler.py:433-453`）是改动 `ProviderRequest` 的**最后一站**。
- **修法**：所有 prompt/contexts/system_prompt/tool 集修改都集中在这里。

### D4. `event.set_result()` 之后没关 t2i → 长文本被渲染成图

- **现象**：明明发的是文本，客户端收到的是一张图。
- **修法**：`MessageEventResult(...).use_t2i(False)`。

### D5. webchat 流式直出无法拦截

- **根因**：webchat 的流式通道绕过了 `on_decorating_result` 的部分路径。
- **修法**：要控制输出，从**源头**（prompt / 工具返回值）消除，不要指望在发送前拦。

---

## E. 配置与数据

### E1. 把数据写进插件目录 → 插件更新失败（Windows 专属）

- **现象**：更新插件时卡住/失败，日志里 `WinError 32`（文件被占用）；
  或者更新到一半插件坏了。
- **根因**：AstrBot 更新插件前会 `remove_dir(plugin_path)` 再解压；
  插件自己在该目录里持有长生命周期的文件句柄（SQLite 连接、FAISS 索引、日志文件）就会挡住删除。
- **修法**：**所有**运行时数据写到 `StarTools.get_data_dir()`（= `data/plugin_data/<插件名>`）。
  迁移旧数据时要连带 `-wal` / `-shm` / `-journal` 一起搬（真实项目 `astrbot_plugin_quillplus`
  的 `_paths.py` 就是专门做这件事的）。
- **附带**：外部数据根不可用时要**降级**，不要让插件启动直接失败。

### E2. 配置值类型不确定（面板可能传字符串）

- **现象**：`bool("false") is True`，于是"关掉的开关"其实开着。
- **根因**：WebUI 表单可能把 `false` 传成字符串 `"false"`。
- **修法**：写 `_safe_bool(v)` 之类的容错转换。

### E3. 配置写坏 → 阻断插件加载

- **根因**：schema 与已落盘 JSON 不一致时加载会失败。
- **修法**：fail-close（读不到就退回默认值），不要 `raise`。

### E4. 用了 `astrbot.api.star.config`（旧 API）

- **根因**：`core/star/config.py:1` 首行就声明该模块已过时。
- **修法**：用 `self.config` + `save_config_async()`。

### E5. 定时任务从 `context.cron_manager` 起，但没做重载清理

- **修法**：官方推荐是 `initialize()` 里自建 asyncio 任务、`terminate()` 里取消。

---

## F. 工程质量（真实项目踩出来的）

### F1. 回滚分支自己会炸

- **现象**：原始异常被 `NameError` 掩盖，排查方向完全跑偏。
- **根因**：把快照变量（`previous_config` 之类）赋在内层 `try` 里，
  却在 `except` 里引用 —— try 早期就失败时，回滚分支拿到未定义变量。
- **修法**：**快照必须建在内层 try 之外**。（`astrbot_plugin_quillplus` v5.2.5 真实事故。）

### F2. 假件（stub）形状与真机不一致 → 三道防线全绿但真机全废

- **现象**：单测全过，装了插件就报 `'coroutine' object has no attribute ...`。
- **根因**：测试用的 request stub 把 `request.json/form/files` 做成**同步属性**，
  而真机里它们是 `async def`。
- **修法**：给 stub 写**形状契约测试**（这些必须是 async def、那些必须是同步属性）；
  真实项目 `astrbot_plugin_quillplus` 有 `tests/test_framework_stub_shape.py` 在 CI 里守。

### F3. 错误信息把内部细节泄给用户

- **现象**：前端弹出 `OSError: [Errno 2] No such file or directory: 'D:\\...'`。
- **修法**：错误类型分离 `message`（用户可见中文短句）/ `detail`（只进日志）/ `context`，
  一律 `XxxError(...) from exc`。

### F4. 诊断指令静默吞异常

- **现象**：用户分不清"没有数据"和"查询炸了"。
- **修法**：诊断类指令**不要**吞异常；正常业务路径才吞。

### F5. 版本号多处漂移

- **现象**：`metadata.yaml` 写 v1.2.0，`@register` 里写 1.1.0，README 徽章又不一样。
- **修法**：版本号单一真源（例如 `<包>/__init__.py` 的 `__version__`），
  写脚本静态检查其他落点是否一致，CI 里跑。

### F6. 顺手改动 / 擅自 git 操作

- **教训**：改插件时不要顺带重构无关模块、不要自动 commit/push/tag —— 先问。
