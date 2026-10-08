# 真实插件索引（`D:\Program\AstrBot\AstrBotData\data\plugins\`）

本机装着 15 个真实插件。**要写新插件时，先从这里找一个结构最接近的抄**，
比从零写快得多，也少踩坑。下表是 2026-10 的实测规模。

| 插件目录 | .py 数 | 代码行 | 一句话 | 抄它什么 |
|---|---|---|---|---|
| `astrbot_plugin_emotionai` | 1 | 996 | 单文件情感分析 | **单文件插件的上限在哪**；最简 `_conf_schema.json` |
| `astrbot_plugin_koharu` | 3 | 1345 | 漫画翻译 | ★**最小标准范例**：`__init__.py` + `main.py` + 独立 client 模块 |
| `astrbot_plugin_splitter` | 9 | 1628 | 长消息切分 | 纯指令类插件的最简分层；`splitter/` 子包 |
| `astrbot_plugin_angel_eye` | 9 | 1366 | 群聊检索 | ★ `tools/` 里的 `@dataclass FunctionTool` 类式工具写法 |
| `antipromptinjector` | 3 | 3331 | 提示注入防护 | 平铺模块（`*_core.py`）+ 自带 `logo.png` / `LICENSE` |
| `astrbot_plugin_continuous_message` | 19 | 4052 | 连续对话 | 中等规模的模块切分；`__init__.py` + 多个 `*_handler.py` |
| `astrbot_plugin_proactive_chat` | 19 | 6434 | 主动搭话 | `core/` + `utils/` + `admin/` 分层；多语言 README |
| `astrbot_plugin_omnidraw` | 17 | 8380 | 绘图 | `providers/` + `models.py` + `pages/` 面板 |
| `astrbot_plugin_quillplus` | 49 | 18384 | 写作辅助 | ★★ **桩范式 + 分层 + 测试基建**（见下） |
| `astrbot_plugin_angel_heart` | 64 | 19670 | 群管 | ★ `web_api/` + `pages/<page>/index.html` 面板；`AGENTS.md` 开发守则 |
| `quill refactor test` | 66 | 25129 | （quillplus 的重构试验田） | 同一套代码的另一种分层 |
| `astrbot_plugin_angel_memory` | 112 | 30833 | 长期记忆 | 超大型插件的目录组织；`docs/astrbot/` 四篇框架机制文档 |
| `meme_manager` | 83 | 32963 | 表情包管理 | ★★ **mixin 式分层**（`main.py` 只做组合） |
| `astrbot_plugin_qq_group_daily_analysis` | 148 | 46495 | 群聊日报 | `src/` 单根分层 + `pages/` |
| `astrbot_plugin_office_assistant` | 132 | 51871 | 办公助手 | ★ `agent_tools/` + `mcp_server/`（自带 MCP 服务端） |

---

## 抄之前先看这几个文件

### 最小标准范例：`astrbot_plugin_koharu`

文件清单就是标准四件套 + 一个业务模块：

```
astrbot_plugin_koharu/
├── main.py                 # 插件入口
├── __init__.py             # 通常只有 from .main import XxxPlugin
├── metadata.yaml
├── _conf_schema.json
├── requirements.txt
├── koharu_client.py        # 与外部服务通信
└── （无 logo.png —— 它是可选的）
```

`main.py:10-52` 的骨架：

```python
@register(PLUGIN_NAME, author, desc, "1.3.0")     # v4 起可省
class KoharuMangaTranslatorPlugin(Star):
    def __init__(self, context, config=None):
        super().__init__(context)
        self.config = config or {}

    async def initialize(self): ...

    @filter.on_llm_request()
    async def on_llm_req(self, event, req):
        event.stop_event()                        # 拦掉原生 LLM 调用

    @filter.command("漫画翻译", alias={...})
    async def translate(self, event):
        yield event.plain_result(...)
```

### 桩范式（要拆多文件时必看）：`astrbot_plugin_quillplus`

**核心约束（BASELINE §1.2 真机 4.28.1 源码实证）**：
钩子/指令函数的 `__module__` 必须与插件注册路径 `data.plugins.<目录>.main` **精确相等**，
框架才会绑定分发。

所以：**装饰器、签名、priority 必须留在 `main.py` 的类体里**，函数体一行委托给别的模块：

```python
# main.py
class QuillPlugin(StatusbarParsersMixin, StatusbarRenderMixin, Star):   # ★ Star 必须最后
    @filter.on_llm_request(priority=100)
    async def on_llm_request(self, event, req):
        return await hooks.on_llm_request(self, event, req)              # 一行委托

# interfaces/astrbot_hooks.py
async def on_llm_request(plugin, event, req):
    ...  # 真正的逻辑
```

它的分层（可直接借鉴）：

```
main.py                       组合根：只放类体 + 装饰器桩（108KB，但桩体都是一行）
commands.py / web_routes.py   指令业务层 / HTTP 层
_route_core.py                纯逻辑 handler（零 HTTP 依赖，可脱离框架单测）
quill/                        框架无关核心（零 astrbot import，由 tests/arch/test_layering.py 用 AST 守卫）
quill_rag/                    RAG 子系统（embedding / FAISS / reranker / sqlite）
interfaces/                   astrbot_hooks.py + web/upload.py
pages/panel/                  原生 ES Modules 面板（刻意不上构建链）
tests/                        21 个测试文件 + framework_stubs + 架构守卫
docs/                         probe_*.py 真机探针 + 验证计划
```

**降级语义分层**（值得抄的判断）：顶层 try/except 只写在「原本就该吞异常」的桩里，
`on_waiting_llm_request` / `on_llm_tool_respond` 这类"炸了会打断 agent loop"的钩子**刻意不包**，
让异常可诊断；而 `on_using_llm_tool` 必须吞（工具参数钩子抛异常会打断 loop）。

### mixin 式分层（超大型插件）：`meme_manager`

```python
class MemeSender(Star, WebAPIMixin, CommandMixin, EventHandlerMixin):    # main.py:43
    ...
```

装饰器分散在各 mixin 里；另有 `_normalize_mixin_handler_module_paths()` 处理多模块 handler 绑定。
代价是要自己解决上面那个 `__module__` 绑定问题——**新手不要一上来就这么写**。

### 面板 + Web API：`astrbot_plugin_angel_heart`

```python
# web_api/__init__.py:345-372
context.register_web_api("/astrbot_plugin_angel_heart/bindings",
                         api.list_bindings, ["GET"], "群聊绑定列表")
```

配上 `pages/chat-config/index.html` 就是 WebUI 里的插件页面。

---

## 框架自带的开发文档（很有限，但要看）

AstrBot 仓库里**没有独立开发文档**（`find -maxdepth 2 -iname "*.md"` 在安装根无产出）。
唯一的框架内文档是：

- `backend/app/astrbot/core/star/README.md`
- 官方文档 URL 只出现在一处注释：`core/star/config.py:1` → `https://docs.astrbot.app/dev/plugin.html`

**更有价值的是插件自带的 agent 守则**（别人写好的规范，可直接拿来当上下文）：

- `astrbot_plugin_angel_heart/AGENTS.md`
- `astrbot_plugin_angel_memory/AGENTS.md`
- `astrbot_plugin_angel_memory/docs/astrbot/` 四篇：
  `extra_content_usage.md`、`plugin_event_injection_guide.md`、
  `plugin_prompt_injection_guide.md`、`tool_loop_agent_guide.md`

---

## 一个真实的开发守则（摘自 `astrbot_plugin_quillplus/README.md`）

> **日志一律使用 `from astrbot.api import logger`**，禁止 `import logging` / `logging.getLogger()`。
> 这是 AstrBot 插件市场的硬性上架规则（LLM Guard 审查项），**违反会直接 Rejected**。
> 全仓库应当满足：`grep -rn "import logging" --include=*.py .` 输出为空。

配套还有：

- 版本号单一真源（`quill/__init__.py:__version__`）+ `tools/check_version.py` 静态对拍其他落点，
  不一致就退出码 1，CI 里在 pytest 之前跑。
- `AGENT.md` 四条硬性禁令：版本号四落点不许动；**未经用户明说禁止任何 git 操作**；
  用户可见变化记进 CHANGELOG 顶部 `## [未发布]`；不许顺手改动无关代码。
