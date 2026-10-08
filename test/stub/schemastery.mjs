/**
 * @deepseek-ai/schemastery 的最小替身。
 *
 * 只实现本插件实际用到的子集：Schema.object / string / number / boolean，
 * 以及 .default() / .volatile() / .description() 三个链式方法。
 *
 * 语义要点（与真实实现对齐的部分）：
 *   - Schema.xxx() 返回的是**可调用对象**，调用时传入原始值、返回解析后的值；
 *   - Schema.object(props) 被调用时，缺省字段回落到各自的 default；
 *   - .volatile() 只打标记，真实的「冻结成 { get() } 引用」由 DSH 运行时做，
 *     所以本插件两种形态都必须能读（readField 就是在处理这件事）。
 */

function makeChain(spec) {
  const field = function (value) {
    return value === undefined ? spec.default : value
  }
  field.__spec = spec
  field.default = function (v) {
    spec.default = v
    return field
  }
  field.volatile = function () {
    spec.volatile = true
    return field
  }
  field.description = function (text) {
    spec.description = text
    return field
  }
  field.required = function () {
    spec.required = true
    return field
  }
  return field
}

export function string() {
  return makeChain({ type: 'string', default: '' })
}

export function number() {
  return makeChain({ type: 'number', default: 0 })
}

export function boolean() {
  return makeChain({ type: 'boolean', default: false })
}

export function array(inner) {
  return makeChain({ type: 'array', inner, default: [] })
}

export function object(properties) {
  const field = function (value) {
    const source = value && typeof value === 'object' ? value : {}
    const out = {}
    for (const key of Object.keys(properties)) {
      const prop = properties[key]
      const raw = source[key]
      if (raw === undefined) {
        out[key] = typeof prop === 'function' && prop.__spec ? prop(undefined) : undefined
      } else {
        out[key] = raw
      }
    }
    // 保留用户传入但 schema 未声明的键（真实实现也会带过去）
    for (const key of Object.keys(source)) {
      if (!(key in out)) out[key] = source[key]
    }
    return out
  }
  field.__props = properties
  field.default = function (v) {
    field.__default = v
    return field
  }
  return field
}

export function union() {
  return makeChain({ type: 'union', default: undefined })
}

export function const_(v) {
  return makeChain({ type: 'const', default: v })
}

export default { string, number, boolean, array, object, union, const: const_ }
