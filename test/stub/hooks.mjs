/**
 * 模块解析钩子：只拦 DSH 私有依赖，其余交给 Node 原生解析。
 */
const MAP = {
  '@deepseek-ai/schemastery': './schemastery.mjs',
  '@deepseek-ai/dsh-tools': './dsh-tools.mjs',
}

export async function resolve(specifier, context, next) {
  const rel = MAP[specifier]
  if (rel) {
    return { url: new URL(rel, import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
