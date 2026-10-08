/**
 * @deepseek-ai/dsh-tools 的最小替身。
 *
 * 真实实现里 defineTool 会做参数规范化、把 execute 包成官方 tool runtime 的
 * 调用约定、并校验 output.schema。本插件在 lib/index.js:685-712 已经自己做完
 * 这些（per-property required 标记、output.schema + render、整体 try/catch），
 * 所以替身只需要原样返回定义，让离线测试能检查定义本身。
 */
export function defineTool(def) {
  return def
}

export function defineTools(defs) {
  return defs
}

export default { defineTool, defineTools }
