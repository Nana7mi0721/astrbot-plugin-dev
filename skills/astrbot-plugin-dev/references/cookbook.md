# AstrBot 插件开发 Cookbook（照抄即可的配方）

所有配方都基于 4.28.x 源码。`event` 一律是 `AstrMessageEvent`，`self` 是 `Star` 子类实例。

---

## 1. 最小可运行插件（4 个文件）

```
data/plugins/astrbot_plugin_demo/
├── main.py
├── metadata.yaml
├── _conf_schema.json      # 可选
└── requirements.txt       # 可选
```

`metadata.yaml`

```yaml
name: astrbot_plugin_demo
desc: 演示插件
version: v1.0.0
author: your_name
repo: https://github.com/you/astrbot_plugin_demo
astrbot_version: ">=4.16,<5"
```

`main.py`

```python
from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star
from astrbot.api import logger


class DemoPlugin(Star):
    def __init__(self, context: Context, config: dict = None):
        super().__init__(context)
        self.config = config or {}

    async def initialize(self):
        logger.info("demo plugin initialized")

    async def terminate(self):
        logger.info("demo plugin terminated")

    @filter.command("demo")
    async def demo(self, event: AstrMessageEvent):
        """演示指令"""
        yield event.plain_result("hello from demo")


__all__ = ["DemoPlugin"]
```

> 注意：`__init__(self, context, config=None)` 里要自己存 `config`——`Star.__init__`
> 只保存 `context`，不保存 `config`（`core/star/base.py:19-28`）。

---

## 2. 带类型参数的指令

```python
@filter.command("roll", alias={"掷骰子"})
async def roll(self, event: AstrMessageEvent, count: int = 1, sides: int = 6):
    """掷骰子

    Args:
        count(int): 掷几次，默认 1
        sides(int): 几面骰，默认 6
    """
```

- 参数类型由 `CommandFilter` 的 `init_handler_md` 从**类型注解**解析并自动转换
  （int/float/bool；bool 接受 `true/yes/1` 与 `false/no/0`，`core/star/filter/command.py:93-173`）。
- 缺参数时抛「必要参数缺失。该指令完整参数: …」。
- 解析结果会写进 `event.set_extra("parsed_params", params)`（`command.py:218`）。

### ★ GreedyStr 的坑（真实事故）

`GreedyStr`（`command.py:15`）必须放在**最后一个参数**，否则 `command.py:106-109` 抛 `ValueError`。

但更要命的是：**`GreedyStr` 一旦带默认值，就会退化成普通 `str`（只吃一个 token）**。
原因是 `init_handler_md` 把"有默认值的形参"记成默认值本身而不是注解。

```python
# ❌ 错误：rest 只会拿到第一个词
@filter.command("wb")
async def wb(self, event: AstrMessageEvent, rest: GreedyStr = ""):

# ✅ 正确：无默认值的具名 GreedyStr，自己切分
@filter.command("wb")
async def wb(self, event: AstrMessageEvent, rest: GreedyStr):
    name, _, action = rest.partition(" ")
```

---

## 3. 发各类消息

```python
from astrbot.api.event import MessageChain
import astrbot.api.message_components as Comp

# 纯文本
yield event.plain_result("文本")

# 图片（三种来源）
yield event.chain_result([Comp.Image.fromURL("https://x/y.png")])
yield event.chain_result([Comp.Image.fromFileSystem(r"D:\a\b.png")])
yield event.chain_result([Comp.Image.fromBase64(b64_str)])     # 不带 data: 前缀

# @ 某人 + 引用回复
yield event.chain_result([
    Comp.At(qq=event.get_sender_id()),
    Comp.Plain(" 收到\n"),
    Comp.Reply(id=event.message_obj.message_id),
])

# 合并转发（QQ）
node = Comp.Node(content=[Comp.Plain("第一行")], name="机器人", uin=event.get_self_id())
yield event.chain_result([Comp.Nodes(nodes=[node])])

# 关闭文本转图片渲染（默认长文本会被 t2i 转图，很多插件统一关掉）
chain = MessageChain().message("文本").use_t2i(False)
yield event.chain_result(chain.chain)

# 语音 / 文件
yield event.chain_result([Comp.Record.fromFileSystem(r"D:\a\b.mp3")])
yield event.chain_result([Comp.File(name="a.txt", file=r"D:\a\a.txt")])
```

★ `Comp.File` 的本地路径存在 **`file_`** 字段；`File.file` 这个 property 在"只给了 url 没给文件"时
会**在事件循环里同步下载**（`components.py:776-798`，并打 warning「请使用 await get_file()」）。
要拿文件路径用 `await comp.get_file()`。

---

## 4. 主动推送（不依赖用户消息）

```python
from astrbot.core.platform.message_session import MessageSession   # 或直接给字符串

umo = "aiocqhttp:FriendMessage:123456789"     # 平台名:消息类型:会话ID
ok = await self.context.send_message(umo, MessageChain().message("定时提醒"))
if not ok:
    logger.warning("send failed: platform not found or unsupported")
```

- `Context.send_message`（`core/star/context.py:614`）：字符串会走 `MessageSesion.from_str` 解析；
  内部按 `platform.meta().id == session.platform_name` 找平台实例，找不到只 warning + 返回 False。
- qq_official 平台不支持主动推送。
- UMO 里的平台名必须与 `platform.meta().id` **完全一致**，否则静默失败。

---

## 5. 多轮会话（session_waiter）

```python
from astrbot.api.event import AstrMessageEvent
from astrbot.api.util import session_waiter, SessionController

@filter.command("设置名字")
async def set_name(self, event: AstrMessageEvent):
    yield event.plain_result("请回复你想设置的名字（30 秒内）")

    @session_waiter(timeout=30)
    async def waiter(controller: SessionController, ev: AstrMessageEvent):
        name = ev.message_str.strip()
        if not name:
            controller.keep(timeout=30, reset_timeout=True)   # 继续等
            return
        # 存下来 ...
        await ev.send(MessageChain().message(f"好的，叫 {name} 了"))
        controller.stop()                                      # 结束等待

    await waiter(event)
```

`@session_waiter(timeout=30, record_history_chains=False)`（`core/utils/session_waiter.py:174`）
装饰的是一个 `(controller, next_event)` 协程；`controller.stop(error=None)` / `controller.keep(...)`。

---

## 6. 接管 / 改写 LLM 请求

```python
@filter.on_llm_request()
async def inject(self, event: AstrMessageEvent, req: ProviderRequest):
    # 注入 system prompt
    req.system_prompt = (req.system_prompt or "") + "\n你是群里的猫娘。"
    # 注入上下文（OpenAI messages 格式）
    req.contexts.append({"role": "user", "content": "[系统提示：现在下雨]"})
    # 收窄可用工具
    # req.func_tool = None

@filter.on_waiting_llm_request()
async def gate(self, event: AstrMessageEvent):
    if event.get_message_str().startswith("闭嘴"):
        event.stop_event()      # 这一步不调 LLM
```

`ProviderRequest` 字段见 SKILL.md §9；`req.contexts` 就是 OpenAI 的 messages 列表。

---

## 7. 屏蔽原生人格注入

```python
@filter.on_llm_request()
async def no_persona(self, event, req: ProviderRequest):
    if req.conversation:
        req.conversation.persona_id = "[%None]"
```

（真实插件 `astrbot_plugin_quillplus` 用的就是这个写法。）

---

## 8. 注册 LLM 工具（两种风格）

见 SKILL.md §3.5。类式（推荐用于复杂工具）：

```python
import json
from dataclasses import dataclass, field
from astrbot.api import FunctionTool

@dataclass
class QueryTool(FunctionTool):
    name: str = "query_history"
    description: str = "查询本群历史消息"
    parameters: dict = field(default_factory=lambda: {
        "type": "object",
        "properties": {"keyword": {"type": "string", "description": "关键词"}},
        "required": ["keyword"],
    })

    async def run(self, event, keyword: str) -> str:
        return f"'{keyword}' 找到 3 条"

# 注册（在 __init__ 或 initialize 里）
self.context.add_llm_tools(QueryTool())
```

- 重名工具会**替换**旧的并打 warning（`core/star/context.py:679`）。
- 注册后默认就是激活状态。

---

## 9. 注册 HTTP 路由（给 WebUI 面板/外部调用）

```python
from astrbot.api.web import json_response, error_response, PluginRequest

async def handle_list(req: PluginRequest):
    return json_response({"items": []})

# 在 __init__ 里
self.context.register_web_api("/myplugin/items", handle_list, ["GET"], "条目列表")
# 外部访问：GET /api/plug/myplugin/items
```

- 同一 route + methods 重复注册会**覆盖**（`context.py:705`）。
- `PluginRequest` 的 `json` / `form` / `files` 是 **async 方法**，必须 `await req.json()`；
  写同步属性访问会拿到 coroutine（真实插件踩过）。

---

## 10. 后台定时任务

官方推荐在插件内自建 asyncio 任务（框架的 `CronJobManager` 也在 `context.cron_manager` 上，但插件侧少用）：

```python
import asyncio

class MyPlugin(Star):
    def __init__(self, context, config=None):
        super().__init__(context)
        self.config = config or {}
        self._task = None

    async def initialize(self):
        self._task = asyncio.create_task(self._loop())

    async def terminate(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self):
        while True:
            try:
                await asyncio.sleep(300)
                await self.do_work()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"loop error: {e}")
```

★ **注意热重载语义**：重载 = 从 `sys.modules` 剔除后重新 import，旧实例的 `terminate()` 会被调用，
但如果你的后台任务没有在 `terminate()` 里取消，它会变成孤儿任务继续跑。

---

## 11. 持久化数据放哪

```python
from astrbot.api.star import StarTools

data_dir = StarTools.get_data_dir()          # data/plugin_data/<插件名>，自动创建
db_path = data_dir / "mydata.db"
```

- 显式传插件名：`StarTools.get_data_dir("astrbot_plugin_demo")`（跨模块调用时必须传，
  否则靠 `inspect.currentframe()` 反查 `star_map` 会抛
  `RuntimeError("Unable to resolve metadata for module ...")`）。
- **绝不要写进插件自己的目录**：AstrBot 更新插件时会 `remove_dir(plugin_path)` 后重新解压，
  长期持有的文件句柄（SQLite/FAISS）会导致 Windows `WinError 32`，更新装一半就失败。
  真实项目 `astrbot_plugin_quillplus` 就是踩了这个坑后专门写了 `_paths.py` 做迁移。

---

## 12. 读配置 + 写配置

```python
# 读（AstrBotConfig 是 dict 子类；缺 key 返回 None 不抛）
threshold = self.config.get("threshold", 0.7)
enabled = self.config.get("enabled", True)

# 写（同步版会阻塞事件循环，优先用 async 版）
self.config["threshold"] = 0.9
await self.config.save_config_async()
```

落盘位置 `data/config/<插件目录名>_config.json`。

---

## 13. 日志

```python
from astrbot.api import logger

logger.debug("...")
logger.info("...")
logger.warning("...")
logger.error("...")
```

- 这个 `logger` 是代理，会按**调用方模块**自动路由到 `astrbot.plugin.<插件名>`。
- **不要** `import logging` / `logging.getLogger()`（插件市场 LLM Guard 审查会直接 Rejected）。
- 不要用 `print()`：它不进日志通道，`astrbot_logs` 也抓不到。

---

## 14. 平台差异化处理

```python
@filter.platform_adapter_type("aiocqhttp")           # 接受字符串
async def only_qq(self, event): ...

if event.get_platform_name() == "aiocqhttp":
    ...
```

- 9 个平台会把 `**加粗**` 与 ``` 代码围栏原样显示 → 需要纯文本模板时按平台分支。
- 私聊判断不要在适配器层做：所有适配器统一用 `MessageType.FRIEND_MESSAGE`，
  误用字符串 `"PrivateMessage"` 会让私聊分支永不进入。
