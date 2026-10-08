/**
 * 离线测试加载器：把 DSH 运行时才存在的包替换成本地替身。
 *
 * 用法：node --import ./test/stub/register.mjs test/smoke.mjs
 *
 * 这样 npm test 不需要装 @deepseek-ai/* 就能跑（本机没有 DSH 的 node_modules）。
 */
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
