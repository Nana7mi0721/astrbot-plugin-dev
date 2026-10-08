---
name: astrbot-plugin-dev
description: AstrBot 插件开发规范与 API 全表（基于 4.28.x 源码逐行核对）。写新插件、改现有插件、查装饰器/@filter、事件对象 AstrMessageEvent、消息组件 Comp、_conf_schema.json 配置、Star 生命周期 initialize/terminate、热重载语义、LLM 工具与 hook、Context API、Web API 路由、定时任务、会话等待时使用。含最小可复制骨架与硬性守则清单。
---

# SKILL：AstrBot 插件开发

对象：AstrBot **4.28.x**（本机安装根 `D:\Program\AstrBot`，框架源码在 `<安装根>/backend/app/astrbot/`）。
下文所有 `文件:行号` 都相对该源码根，用来核对时直接跳转。

> 遇到本 skill 没写到的细节，**先去源码里查**，不要凭记忆写 API：
> - 装饰器实现全在 `core/star/register/star_handler.py`
> - 事件对象在 `core/platform/astr_message_event.py`
> - 消息组件在 `core/message/components.py`
> - 加载/卸载/热重载全流程在 `core/star/star_manager.py`
> 把源码根当权威，本 skill 当索引。

---

## §1 插件的最小形态

一个能被 AstrBot 发现的插件目录（放在实例的 `data/plugins/<目录名>/`）：

| 文件 | 必需性 | 硬性要求 |
|---|---|---|
| `main.py` | **发现入口** | 目录内必须有 `main.py`；没有则退而找 `<目录名>.py`；都没有 → `logger.info("Plugin X has neither main.py nor X.py; skipping it.")` **静默跳过**（`core/star/star_manager.py:291-321`）。模块路径固定 `data.plugins.<目录名>.main`（`star_manager.py:1128-1129`） |
| `metadata.yaml` / `.yml` | **事实必需** | 四字段 `name`/`desc`/`version`/`author` 必须非空字符串（`core/star/updater.py:26` `PLUGIN_METADATA_REQUIRED_FIELDS`，校验在 `updater.py:379-393`）；文件 >1MB 抛错（`updater.py` `PLUGIN_METADATA_MAX_BYTES = 1024*1024`） |
| `_conf_schema.json` | 可选 | 文件名是常量 `conf_schema_fname`（`star_manager.py:214`）。合法 `type` 只有 10 种，写错 → 整个插件加载失败 |
| `requirements.txt` | 可选 | 固定路径 `<插件目录>/requirements.txt`（`star_manager.py:1122`），存在则自动 pip 安装 |
| `logo.png` | 可选 | 常量 `logo_fname`（`star_manager.py:215`） |
| `pages/<page>/index.html` | 可选 | WebUI 插件页面（范例 `astrbot_plugin_angel_heart/pages/chat-config/index.html`） |
| `.astrbot-plugin/i18n/<locale>.json` | 可选 | 自动扫描，单文件 ≤1MB（`star_manager.py:565-607`） |

`metadata.yaml` 可用字段（`updater.py:25` 起）：

```yaml
name: astrbot_plugin_example        # 必需，非空字符串
desc: 一句话说明插件做什么            # 必需（别名 description）
version: v1.0.0                     # 必需
author: your_name                   # 必需
short_desc: 短描述                   # 可选，列表页显示
repo: https://github.com/you/repo   # 可选
display_name: 显示名                 # 可选
support_platforms: [aiocqhttp, telegram]   # 可选，元素取 ADAPTER_NAME_2_TYPE 的 key
astrbot_version: ">=4.16,<5"        # 可选，PEP 440 区间
pages: [...]                        # 可选
```

- `support_platforms` 的合法取值来自 `core/star/filter/platform_adapter_type.py:33-54` 的 `ADAPTER_NAME_2_TYPE` key：
  `aiocqhttp` / `qq_official` / `telegram` / `discord` / `webchat` / `lark` / `dingtalk` / `slack` /
  `kook` / `wecom` / `satori` / `misskey` / `line` / `matrix` / `mattermost` 等。
- **`astrbot_version` 写 PEP 440 区间**，由 `star_manager.py:671-703` 用
  `SpecifierSet(normalized_spec).contains(VERSION, prereleases=True)` 校验，不满足抛
  `PluginVersionUnsupportedError` → `f"AstrBot {VERSION} does not satisfy plugin astrbot_version: {normalized_spec}"`。
  正确：`">=4.26.0"`、`">=4.17.0"`、推荐 `">=4.16,<5"`。**不要写裸 `v4.28.2`。**

> ⚠️ `metadata.yaml` 的优先级**高于**装饰器里的同名参数。两者不一致时以文件为准。

---

## §2 主类骨架（可直接复制）

```python
# main.py
from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star
from astrbot.api import logger
import astrbot.api.message_components as Comp


class MyPlugin(Star):
    def __init__(self, context: Context, config: dict = None):
        super().__init__(context)
        # Star.__init__ 只保存 context，不保存 config —— 必须自己存！
        self.config = config or {}

    async def initialize(self):
        """插件被激活时调用（star_manager.py:1419-1421）。长耗时初始化放这里。"""
        logger.info("my plugin initialized")

    async def terminate(self):
        """插件被禁用/重载时调用。★ 绝对不要同时定义 __del__，否则这个函数不会被执行。"""
        pass

    @filter.command("hello")
    async def hello(self, event: AstrMessageEvent):
        """说你好"""
        yield event.plain_result("你好！")

    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    @filter.command("roll")
    async def roll(self, event: AstrMessageEvent, count: int = 1):
        """掷骰子

        Args:
            count(int): 掷几次
        """
        import random
        yield event.plain_result("、".join(str(random.randint(1, 6)) for _ in range(count)))
```

要点：

- `class MyPlugin(Star)` —— `Star` 定义在 `core/star/base.py:19-28`（`class Star(CommandParserMixin, PluginKVStoreMixin)`）。
- **v3.5.19 起自动注册**：`__init_subclass__`（`base.py:64-75`）把子类塞进 `star_map`/`star_registry`，
  **不需要** `@register`。`@register`（`core/star/register/star.py:17-20`）已废弃，调用会发 DeprecationWarning。
  本地真实插件（splitter / meme_manager / continuous_message）都没写它。
- handler **必须 `async def`**。
- `__init__(self, context, config=None)` 的 `config` 可能真是 `None`（`star_manager.py:1219-1223` 构造失败时会降级只传 context），必须容错。
- 生命周期钩子（`base.py:107-114`）：`async def initialize()` / `async def terminate()` / `def __del__()`（**已废弃**）。
  `_terminate_plugin`（`star_manager.py:1928-1976`）的逻辑是
  `if "__del__" in cls.__dict__: run_in_executor(None, cls.__del__) elif "terminate" in cls.__dict__: await cls.terminate()`
  —— **同时定义两者时只调 `__del__`，`terminate` 被静默跳过。**

---

## §3 装饰器速查

全部写法：`from astrbot.api.event import filter`，然后用 `@filter.xxx`。
短名在 `api/event/filter/__init__.py`，实现全在 `core/star/register/star_handler.py`。

### 3.1 指令与正则

| 装饰器 | 实现 | 说明 |
|---|---|---|
| `@filter.command(name=None, alias=None, sub_command=None)` | `star_handler.py:75-126` | **受 wake_prefix 制约**（默认 `/`）；`alias` 是 `set[str]` |
| `@filter.command_group(name)` | `:208-248` | 只给组名 → `raise ValueError("参数不足。…指令树…")` |
| `@filter.regex(r"...")` | `:297-309` | **不受 wake_prefix 制约**，用 `re.search` |
| `@filter.custom_filter(cls, raise_error=True)` | `:129-205` | 自定义过滤器类，支持 `&` / `|` 组合 |

### 3.2 消息与平台筛选

| 装饰器 | 实现 | 说明 |
|---|---|---|
| `@filter.event_message_type(EventMessageType.X)` | `:262-274` | 枚举在 `filter/event_message_type.py:10-14`：`GROUP_MESSAGE`/`PRIVATE_MESSAGE`/`OTHER_MESSAGE`/`ALL`（`enum.Flag`，可 `\|`） |
| `@filter.platform_adapter_type(PlatformAdapterType.X)` | `:277-294` | **接受字符串**；枚举在 `filter/platform_adapter_type.py:9-30`（21 成员 + `ALL`） |
| `@filter.permission_type(PermissionType.X, raise_error=True)` | `:312-334` | 枚举在 `filter/permission.py:9-15`：`ADMIN`/`MEMBER`/`GROUP_ADMIN`/`SHARED_GROUP_ADMIN` |

### 3.3 生命周期 hook

| 装饰器 | 实现 | 回调签名 |
|---|---|---|
| `@filter.on_astrbot_loaded()` | `:337-344` | `(self)` |
| `@filter.on_platform_loaded()` | `:347-354` | `(self)` |
| `@filter.on_plugin_error()` | `:357-372` | `(self, event, plugin_name, handler_name, error, traceback_text)`；`event.stop_event()` 可屏蔽默认报错回显 |
| `@filter.on_plugin_loaded()` / `on_plugin_unloaded()` | `:375-406` | `(self, metadata)` |

### 3.4 LLM 请求/响应 hook（改模型行为的主战场）

| 装饰器 | 实现 | 回调签名与时机 |
|---|---|---|
| `@filter.on_waiting_llm_request()` | `:409-430` | `(self, event)` —— 决定要不要调 LLM 之前 |
| `@filter.on_llm_request()` | `:433-453` | `(self, event, req: ProviderRequest)` —— **改 req 的最后一站**（改 prompt/contexts/system_prompt/tool 集都在这里） |
| `@filter.on_llm_response()` | `:456-476` | `(self, event, response: LLMResponse)` |
| `@filter.on_agent_begin()` | `:479-504` | `(self, event)` |
| `@filter.on_agent_done()` | `:507-534` | `(self, event)` |
| `@filter.on_using_llm_tool()` | `:537-558` | `(self, event, tool: FunctionTool, tool_args)` |
| `@filter.on_llm_tool_respond()` | `:561-583` | `(self, event, tool, tool_args, tool_result)` |
| `@filter.on_decorating_result()` | `:730-741` | `(self, event)` —— **发送前**最后一站，可改 `event.get_result()` |
| `@filter.after_message_sent()` | `:744-755` | `(self, event)` |

### 3.5 LLM 工具与子 agent

| 装饰器 | 实现 | 说明 |
|---|---|---|
| `@filter.llm_tool(name=None)` | `:586-683` | 参数**只从 docstring `Args:` 解析**，每个业务参数**必须写类型** |
| `@filter.agent(name, instruction, tools=None, run_hooks=None)` | `:697-727` | 返回 `RegisteringAgent`，其内可再 `@x.llm_tool` |

`@filter.llm_tool` 的硬性规则（`register/star_handler.py:635-655`）：

- 参数说明**只**来自 docstring 的 `Args:` 段；`event` 参数**不要**写进 Args。
- 每个业务参数缺类型注解 → `raise ValueError(f"LLM 函数工具 …_的参数 {arg.arg_name} 缺少类型注释。")`，**直接中断插件导入**。
- 支持类型：`string` / `number` / `object` / `array` / `boolean`，以及 `list[string]` 这种 `(\w+)\[(\w+)\]` 写法；
  其他类型同样抛错。
- 工具名缺省 = 函数名（`:631`）。
- **返回 `str` → 结果并进下一轮 prompt；返回 `None` → 静默丢弃**（`:604-608`）。
  可以在里面 `yield` 发消息；`event.stop_event()` 后再 `yield` 可终止循环。
- 实际调用签名是 `handler(self, event, **llm_args)`（`core/astr_agent_tool_exec.py:761-765` 判定
  `if method_name == "run" or "decorator_handler": ready_to_call = handler(event, *args, **kwargs)`，
  配合 `functools.partial` 绑定）。

```python
@filter.llm_tool()
async def get_weather(self, event: AstrMessageEvent, city: str):
    """查询某城市天气

    Args:
        city(string): 城市名，例如 北京
    """
    return f"{city}：晴，25℃"     # 返回 str 才会被送回模型
```

**类式工具（本地真实插件的主流做法）**：更多复杂插件用 `FunctionTool` 子类 +
`context.add_llm_tools(*tools)`（`core/star/context.py:679`，重名会替换并 warning）。
`FunctionTool` 定义在 `core/agent/tool.py:41`。

```python
from dataclasses import dataclass
from astrbot.api import FunctionTool

@dataclass
class MyTool(FunctionTool):
    name: str = "my_tool"
    description: str = "做某事"
    parameters: dict = None       # JSON Schema

    async def run(self, event, **kwargs) -> str:
        ...
```

---

## §4 事件对象 `AstrMessageEvent`

`core/platform/astr_message_event.py`（535 行）。

**实例属性**：`message_str`(L45)、`message_obj`(L47)、`platform_meta`(L49)、
`role`（`"member"`，管理员 `"admin"`，L51）、`is_wake`(L53)、`is_at_or_wake_command`(L55)、
`_extras`(L57)、`session: MessageSession`(L70)、`created_at`(L80)、`call_llm`(L94)、`plugins_name`(L99)。

**property**：`unified_msg_origin -> str`(L105，**格式 `平台名:消息类型:会话ID`**，有 setter)、`session_id`(L116)。

**同步方法**

| 方法 | 行 | 说明 |
|---|---|---|
| `get_platform_name()` / `get_platform_id()` | 126 / 133 | |
| `get_message_str()` | 140 | |
| `get_message_outline()` | 173 | 图片→`[图片]`、At→`[At:qq]`、Reply→`[引用消息(…)]` |
| `get_messages()` | 180 | 消息组件列表 |
| `get_message_type()` | 184 | |
| `get_session_id()` / `get_group_id()` | 191 / 195 | **`get_group_id()` 私聊返回 `""`** |
| `get_self_id()` / `get_sender_id()` / `get_sender_name()` | 199 / 203 / 210 | |
| `set_extra` / `get_extra` / `clear_extra` | 222 / 226 / 232 | |
| `is_private_chat()` / `is_wake_up()` / `is_admin()` | 260 / 264 / 268 | |
| `set_result` / `get_result` / `clear_result` | 319 / 379 / 383 | |
| `stop_event()` | 348 | 置 `_force_stopped=True` 并连带 result |
| `continue_event()` / `is_stopped()` | 356 / 364 | |
| `should_call_llm(bool)` | 372 | |
| `make_result()` / `plain_result(text)` / `image_result(url)` / `chain_result(chain)` | 389 / 404 / 408 / 417 | |
| `request_llm(...)` | 425-436 | 同步，返回 `ProviderRequest` 供 yield |
| `process_buffer(buffer, pattern)` | 272 | 每段 sleep 1.5s 限速 |
| `send_streaming(gen, use_fallback=False)` | 285 | 仅 telegram / qq official 私聊 |
| `send_typing()` / `stop_typing()` | 299 / 305 | |
| `track_temporary_local_file` / `untrack` / `cleanup` | 237 / 241 / 246 | |

**async 方法**

| 方法 | 行 | 说明 |
|---|---|---|
| `await event.send(message: MessageChain)` | 483 | ★**参数是 MessageChain，不是 str** |
| `await event.react(emoji)` | 502 | 贴表情 |
| `await event.get_group(group_id=None, **kwargs)` | 511 | |

废弃：`_pre_send`(L311) / `_post_send`(L315)。

`request_llm` 完整签名（L425-436）：

```python
def request_llm(self, prompt, func_tool_manager=None, tool_set=None, session_id="",
                image_urls=None, audio_urls=None, contexts=None, system_prompt="",
                conversation=None) -> ProviderRequest
```

---

## §5 消息组件与 MessageChain

`import astrbot.api.message_components as Comp`（api 侧只有一行 re-export；实现全在
`core/message/components.py`，944 行，全部是 pydantic `BaseModel`）。

| 组件 | 行 | 关键构造 |
|---|---|---|
| `Plain(text, convert=True)` | 113 | |
| `Face(id)` | 127 | |
| `Record` | 135 | `fromFileSystem`(151, `file://` URI) / `fromURL`(156) / `fromBase64`(162, `base64://`) |
| `Video(file)` | 288 | |
| `At(qq, name)` / `AtAll` | 410 / 425 | `AtAll` 就是 `qq="all"` |
| `Image` | **501** | `fromURL`(512) / `fromFileSystem`(518) / `fromBase64`(523) / `fromBytes`(527) / `fromIO`(531) |
| `Reply(id, chain, sender_id, sender_nickname, time, message_str)` | 584 | |
| `Poke(poke_type="126")` | 614 | `target_id()`(629) |
| `Forward(id)` / `Node(content, name, uin)` / `Nodes(nodes)` | 647 / 655 / 709 | `Node` 传单个会自动包 list |
| `Json(data)` | 736 | |
| `File(name, file="", url="")` | **764** | ★本地路径存在 **`file_`** 字段；`@property file`(776) 在"有 URL 无文件"时会**同步下载**并在事件循环里 warning（794-798：「请使用 await get_file()」） |
| `Contact(_type, id)` | 464 | 注意下划线 |
| `Location` / `Music` / `Share` / `RPS` / `Dice` / `Shake` / `Unknown(text)` | 473 / 484 / 453 / 432 / 439 / 446 / 746 | |

`MessageChain`（`core/message/message_event_result.py:17`）：字段 `chain`(28) / `use_t2i_`(29) /
`use_markdown_`(30) / `type`(33)；builder 全部 `return self`：
`derive`(36) `message(str)`(49) `at(name,qq)`(60) `at_all`(71) `url_image`(93) `file_image`(106)
`base64_image`(118) `use_t2i(bool)`(127) `use_markdown`(137) `get_plain_text`(149) `squash_plain`(170)。

`MessageEventResult(MessageChain)`(223) 另有 `result_type`/`result_content_type`/`async_stream`/
`stop_event`/`continue_event`/`is_stopped`/`set_async_stream`。`CommandResult = MessageEventResult`(288)。

```python
# 常见四种发消息方式
yield event.plain_result("纯文本")
yield event.image_result("https://... 或本地路径")
yield event.chain_result([Comp.At(qq=event.get_sender_id()), Comp.Plain(" 你好")])
yield event.make_result().message("链式").use_t2i(False)
```

---

## §6 配置：`_conf_schema.json`

**合法 `type` 只有 10 种**（`core/config/default.py:4794-4805` `DEFAULT_VALUE_MAP`）：
`int` `float` `bool` `string` `text` `list` `file` `object` `template_list` `dict`。

写错 type → `core/config/astrbot_config.py:151-154` 直接
`raise TypeError(f"不受支持的配置类型 {v['type']}。支持的类型有：{DEFAULT_VALUE_MAP.keys()}")`，
而这个异常被加载流程的 `except BaseException` 吞掉 → **表现为「插件加载失败」但日志不一定显眼**。

```json
{
  "enabled": { "type": "bool", "description": "是否启用", "default": true },
  "threshold": {
    "type": "float", "description": "阈值", "default": 0.7,
    "slider": { "min": 0, "max": 1, "step": 0.1 }
  },
  "mode": {
    "type": "string", "description": "模式", "default": "a",
    "options": ["a", "b"], "hint": "支持 **Markdown**"
  },
  "group": {
    "type": "object", "description": "分组",
    "items": { "key": { "type": "string", "description": "子项", "default": "" } }
  },
  "providers": { "type": "list", "description": "列表", "default": [] },
  "dict_free": { "type": "dict", "description": "自由映射", "default": {} }
}
```

元字段：`description`(显示名) / `hint`(支持 Markdown) / `default` / `options`(下拉) /
`obvious_hint`(hint 前缀 ‼️) / `invisible` / `collapsed` / `show_key` /
`condition`(`{key: value}` 条件显示) / `slider`(`{min,max,step}`) /
`_special`(`select_plugin_set` | `select_persona`) / `editor_mode|editor_theme|editor_language` /
`templates`(仅 `template_list`)。
`object` 用 `items` 嵌子 schema；`dict` 是自由映射（`check_config_integrity` `astrbot_config.py:172-185`
会保留用户新增的键）。

**运行时读写**：

- `self.config` 是 **`AstrBotConfig`（继承 dict）**，由 `star_manager.py:1219-1223`
  `metadata.star_cls_type(context=self.context, config=plugin_config)` 传入（TypeError 时降级只传 context）。
- 读：`self.config["k"]` / `self.config.get("k", default)` / `self.config.k`
  （`__getattr__` `astrbot_config.py:359-363`，**缺 key 返回 `None`、不抛 KeyError**）。
- 写：`self.config.save_config(replace_config=None, *, indent=2)`(262，同步) 或
  **`await self.config.save_config_async(...)`**(274，走 `asyncio.to_thread`，**不阻塞事件循环**)。
- 落盘位置：`data/config/<插件目录名>_config.json`（`star_manager.py:1165-1170`）。
- ❌ 旧的 `astrbot.api.star.config`（`load_config` / `put_config` / `update_config`）**已过时**
  （`core/star/config.py:1` 首行就声明了这一点）。

---

## §7 生命周期与热重载

加载流程 `star_manager.py:1073-1478`：

1. 导入模块；失败 → 进 `failed_plugin_dict` + `_cleanup_plugin_state()` 后 `continue`（L1136-1154）。
2. 读 schema / metadata；`astrbot_version` 校验 L1200-1211。
3. L1213-1216 `setattr(cls, "name", p_name)` / `"author"` / `"plugin_id"`。
4. L1270-1282 用 `functools.partial(raw_handler, metadata.star_cls)` 绑定实例方法。
5. L1419-1421 `await cls.initialize()` → 派发 `OnPluginLoadedEvent`。
6. **导入期异常被 L1432-1448 的 `except BaseException` 隔离**，只记进 `failed_plugin_dict`，
   **不会崩进程**；最后 `return False, self.failed_plugin_info`。

热重载 = **进程内模块重载，不重启进程**：

- `reload()` `star_manager.py:1015-1071`：`_pm_lock` → `_terminate_plugin` → `_unbind_plugin`
  （del `star_map`、摘 handler 与 `star_handlers_map`、摘 `llm_tools.func_list`、注销平台适配器）→ `load()`。
- `_purge_modules()` L739-771：**把插件模块从 `sys.modules` 删除后重新 import**
  （**不是** `importlib.reload`）→ 模块级可变全局状态不保留、插件实例会重建、`initialize()` 会再跑。
- 触发面：`POST /api/plugin/reload`、`POST /api/plugin/{plugin_id}/reload`
  （`dashboard/api/plugins.py:837,1104`）、`POST /api/plugin/reload-failed`（`:958`）。
  本预设的 `astrbot_reload` 走的是更规范的 `/api/v1/plugins/reload`。
- `turn_off_plugin()` L1902：把 module_path 写进 `shared_preferences.json` 的 `inactivated_plugins`，
  并把该插件所有 `func_tool.active = False`。
- 自动热重载仅当环境变量 `ASTRBOT_RELOAD=1`（`star_manager.py:222`，来自 `cli/commands/cmd_run.py:58 --reload`）
  时启用 watchfiles。真·重启进程是 `core/process_restart.py`。

---

## §8 Context 与 StarTools

`Context`（`core/star/context.py`，894 行）常用方法：

| 方法 | 行 | 说明 |
|---|---|---|
| `send_message(session: str \| MessageSesion, message_chain) -> bool` | 614 | **主动推送**。字符串 session 走 `MessageSesion.from_str` 解析 UMO；按 `platform.meta().id == session.platform_name` 找平台；找不到 → warning + 返回 False；qq_official 不支持 |
| `register_web_api(route, view_handler, methods, desc)` | 705 | 同 route+methods 会覆盖；**对外实际前缀 `/api/plug`** |
| `get_config(umo=None)` | 597 | |
| `get_registered_star` / `get_all_stars` | 346 / 352 | |
| `get_llm_tool_manager` / `add_llm_tools` | 356 / 679 | |
| `activate_llm_tool_async` / `deactivate_llm_tool_async` | 375 / 392 | 注册的工具**默认已激活** |
| `get_provider_by_id` / `get_all_providers` / `get_all_tts_providers` / `get_all_stt_providers` / `get_all_embedding_providers` | 415 / 440 / 444 / 448 / 452 | |
| `get_platform_inst(platform_id)` | 761 | `get_platform()` 已废弃 |
| `get_db` / `register_provider` / `get_event_queue` | 777 / 785 / 733 | |
| `llm_generate(...)` | 171 | 直接调 LLM（**不执行 tool call**） |
| `tool_loop_agent(...)` | 215 | 带工具循环的 agent（`max_steps=30`, `tool_call_timeout=120`） |

已废弃：`get_using_provider`（→ `await context.get_using_provider_async(umo)`，`context.py:482`）、
`register_llm_tool`、`unregister_llm_tool`、`register_commands`、`register_task`
（L881 注释：改为在插件 `initialize()` 里自己起后台任务）。

**`StarTools`**（`core/star/star_tools.py`，`sp` 就是它的实例）：

| 方法 | 行 | 说明 |
|---|---|---|
| `send_message(session, chain) -> bool` | 28 | |
| `create_message(...) -> AstrBotMessage` | 52 | |
| `create_event(abm, platform="aiocqhttp", is_wake=True)` | **101** | ★构造伪事件注入流水线（`adapter.create_event(abm)` + `adapter.commit_event(event)`），用于自测/模拟 |
| `get_data_dir(plugin_name=None) -> Path` | 231 | 返回 `data/plugin_data/<plugin>` 并自动建目录；**省略 plugin_name 时靠 `inspect.currentframe()` 反查 `star_map`**，查不到抛 `RuntimeError("Unable to resolve metadata for module ...")` |
| `activate_llm_tool_async` / `deactivate_llm_tool_async` / `register_llm_tool` / `unregister_llm_tool` | 161 / 179 / 186 / 204 | |

**多轮会话**（`core/utils/session_waiter.py`）：

```python
from astrbot.api.util import session_waiter, SessionController

@session_waiter(timeout=30, record_history_chains=False)   # L174
async def my_waiter(controller: SessionController, event: AstrMessageEvent):
    ...
    controller.keep(timeout=60, reset_timeout=True)   # L32 附近
    controller.stop(error=None)
```

**Web API 路由**（真实用法见 `astrbot_plugin_angel_heart/web_api/__init__.py:345-372`）：

```python
context.register_web_api("/myplugin/bindings", api.list_bindings, ["GET"], "群聊绑定列表")
# 外部访问：/api/plug/myplugin/bindings
```

辅助设施在 `api/web.py`（453 行）：`PluginRequest`/`PluginRequestProxy`(165/254)、
`PluginUploadFile`(95，`await save(dest)`)、`json_response`(342)、`error_response`(365)、
`file_response`(390)、`stream_response`(416)、`bind_request_context`(326)。

**定时任务**：框架有 `core/cron/manager.py` 的 `CronJobManager`(L100，`add_basic_job` 148 /
`add_active_job` 175 / `update_job` 206 / `delete_job` 215 / `list_jobs` 220 / `run_job_now` 310)，
Context 注入 `cron_manager`；但**插件侧的推荐做法**是在 `initialize()` 里自建 asyncio 任务、
在 `terminate()` 里取消。

---

## §9 公开 API 面（只 import 这些）

```python
from astrbot.api import logger, AstrBotConfig, FunctionTool, ToolSet, sp, agent, llm_tool, html_renderer
from astrbot.api.star import Context, Star, StarTools, register          # register 已废弃
from astrbot.api.event import (AstrMessageEvent, CommandResult, EventResultType,
                               MessageChain, MessageEventResult, ResultContentType, filter)
from astrbot.api.provider import (LLMResponse, Personality, Provider, ProviderMetaData,
                                  ProviderRequest, ProviderType, STTProvider)
from astrbot.api.platform import (AstrBotMessage, AstrMessageEvent, Group, MessageMember,
                                  MessageType, Platform, PlatformMetadata, register_platform_adapter)
import astrbot.api.message_components as Comp
from astrbot.api.util import SessionController, SessionWaiter, session_waiter
from astrbot.api.all import *        # 一次性导入全部
```

- `astrbot.api.__all__` = `AstrBotConfig, BaseFunctionToolExecutor, FunctionTool, ToolSet, agent,
  html_renderer, llm_tool, logger, sp`。
- `logger` 是 `_PluginContextLogger` 代理（`api/__init__.py:56-71`），**按调用方模块自动路由到
  `astrbot.plugin.<插件名>`**；非插件调用方回落全局 logger。
- `filter` 不在 `astrbot.api.event.__all__` 里，但作为子模块可以 `from astrbot.api.event import filter`。
- `astrbot.api.message_components` 内部就一行 `from astrbot.core.message.components import *`。

**Provider 调用**：

```python
provider = await self.context.get_using_provider_async(event.unified_msg_origin)
resp: LLMResponse = await provider.text_chat(prompt="...", session_id=..., contexts=[...])
print(resp.completion_text)
```

- `Provider`（`core/provider/provider.py`）：`text_chat`(100) / `text_chat_stream`(139) /
  `get_current_key`(82) / `get_model`(43) / `meta`(47)。
- `ProviderRequest`（`core/provider/entities.py:94-120`）字段：`prompt`、`session_id`、`image_urls`、
  `audio_urls`、`extra_user_content_parts`、`func_tool: ToolSet`、`contexts`（OpenAI 格式）、
  `system_prompt`、`conversation`、`tool_calls_result`、`model`。
- `LLMResponse`（`:355-387`）字段：`role`、`result_chain: MessageChain`、`tools_call_args`/`tools_call_name`/
  `tools_call_ids`、`reasoning_content`、`raw_completion`、`is_chunk`、`id`、`usage`。

---

## §10 硬性守则（写代码前过一遍）

**结构**
1. 目录必须有 `main.py`（或 `<目录名>.py`）。
2. `metadata.yaml` 四字段非空；`astrbot_version` 写 PEP 440 区间。
3. 主类继承 `Star`；`__init__(self, context, config=None)` 必须容错 `config=None`，并自己 `self.config = config`。
4. 不要写 `@register`（已废弃，`__init_subclass__` 自动注册）。
5. 长耗时初始化放 `async initialize()`，清理放 `async terminate()`，**绝不写 `__del__`**。

**事件与消息**
6. handler 一律 `async def`。
7. 拦截消息后要 `event.stop_event()`；`stop_event()` 与 `clear_result()` 语义不同
   （前者终止事件传播并连带清空 result，后者只丢已经产出的结果）。
8. 发消息用 `event.plain_result` / `chain_result` / `image_result`；`await event.send(...)` 只接受 `MessageChain`。
9. 图片用 `Comp.Image.fromURL` / `fromFileSystem` / `fromBase64`。
10. 有下载语义的字段必须 `await`（尤其 `Comp.File` / `Image.convert_to_file_path()`，直接读属性会在事件循环里同步下载）。
11. UMO 是 `平台名:消息类型:会话ID`，平台名必须与 `platform.meta().id` 对上，否则 `send_message` 静默返回 False。
12. `get_group_id()` 私聊返回 `""`，别拿它当会话键 —— 会话键用 `unified_msg_origin`。

**LLM**

13. 改 LLM 请求统一走 `@filter.on_llm_request()`（那是最后一站）。
14. `@filter.llm_tool` 的参数每个都要在 docstring `Args:` 里写类型，否则导入即 ValueError。
15. llm_tool 返回 `str` 才可见，返回 `None` 等于静默。
16. `on_using_llm_tool` / `on_llm_tool_respond` 里的异常会**打断 agent loop**，必须吞异常降级放行。

**配置与数据**

17. `_conf_schema.json` 的 `type` 只用那 10 种；非法 type 会让整个插件加载失败。
18. 配置读用 `self.config.get(...)`；写用 `await self.config.save_config_async()`。
19. 插件私有数据一律走 `StarTools.get_data_dir()`（= `data/plugin_data/<plugin>`），
    **绝不要写进插件目录**（更新插件时会整个目录被替换/删除，Windows 上还常因句柄占用导致更新失败）。
20. 日志用 `from astrbot.api import logger`（自动路由 `astrbot.plugin.<插件名>`），
    **不要 `import logging`**、不要 `print()` —— 这是插件市场上架的硬性审查项。

**框架边界**

21. 只用 `astrbot.api.*` 的导出面，**尽量不 import `astrbot.core.*`**（内部实现随时变）。
22. 避开已废弃 API：`register`、`get_using_provider`、`register_llm_tool`、`register_task`、
    `astrbot.api.star.config`、`__del__`、`_pre_send`/`_post_send`。
23. HTTP 路由用 `context.register_web_api(...)`（对外前缀 `/api/plug`）。
24. 不要做同步阻塞调用（重 IO / 大文件 / 网络）—— 会卡死整个事件循环；要阻塞就用 `asyncio.to_thread`。
25. 热重载下不要持有跨重载的模块级全局状态（重载 = 从 `sys.modules` 剔除后重新 import）。

---

## §11 参考文件

- `references/cookbook.md` —— **照抄即可的配方**：最小插件、带参指令、发各类消息（文本/图片/合并转发/
  文件/语音）、主动推送、多轮会话、接管 LLM 请求、注册 LLM 工具、注册 HTTP 路由、后台定时任务、
  数据持久化、平台差异化。写代码时开着它。
- `references/pitfalls.md` —— 坑清单（现象 → 根因 → 修法），按「加载期静默失败 / 生命周期 /
  事件与消息 / LLM / 配置与数据 / 工程质量」六类组织。**排错先看它**。
- `references/examples.md` —— 本机 15 个真实插件的规模表与"该抄谁"，最小范例与桩范式的完整说明，
  框架自带文档的位置，以及一份真实的开发守则（日志 API 是插件市场上架硬性要求）。
