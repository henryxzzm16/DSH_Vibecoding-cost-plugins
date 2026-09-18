/**
 * dsh-deepseek-cost — 纯函数单测（host 折叠逻辑）
 * 运行：node --test core.test.cjs   （或 node core.test.cjs）
 *
 * 这里不启动 DSH：折叠函数与计价函数都是纯函数，直接喂事件对象即可。
 *
 * 只 import `lib/core.js`（零依赖），**不 import `lib/index.js`** ——
 * index.js 会连带加载 @deepseek-ai/schemastery 与 zod，在没有安装依赖的环境
 * （例如 CI 只做 checkout）会直接 ERR_MODULE_NOT_FOUND。
 * 运行时的投影 schema 契约由 verify-mount.cjs 在装好依赖的本地环境验证。
 */
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let mod = null

function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps)
}

const cases = []
function test(name, fn) {
  cases.push({ name, fn })
}

/** 造一个 assistant/message 事件 */
function usageEvent(usage, time) {
  return { type: 'assistant/message', seq: 1, time: time, data: { turn: 1, step: 1, message: {}, stream: [], usage } }
}

/** 造一个 request/header 事件（决定后续调用的模型） */
function headerEvent(model, time) {
  return { type: 'request/header', seq: 0, time: time, data: { header: { config: { provider: 'deepseek', model } } } }
}

// 北京时间 2026-03-04（周三）10:00 = 高峰
const PEAK_MS = Date.UTC(2026, 2, 4, 2, 0, 0)
// 北京时间 2026-03-04（周三）20:00 = 空闲
const OFF_MS = Date.UTC(2026, 2, 4, 12, 0, 0)
// 北京时间 2026-03-07（周六）10:00 = 周末全天空闲
const WEEKEND_MS = Date.UTC(2026, 2, 7, 2, 0, 0)

test('模型档位：只有 deepseek 计价，pro 与 flash 分开', () => {
  const { modelKey } = mod
  if (modelKey('deepseek-v4.1-flash') !== 'flash') throw new Error('flash 未识别')
  if (modelKey('deepseek-v4-pro') !== 'pro') throw new Error('pro 未识别')
  if (modelKey('gpt-4o') !== null) throw new Error('非 deepseek 不应计价')
  if (modelKey(undefined) !== null) throw new Error('undefined 不应计价')
})

test('峰谷判定：周三 10:00 高峰，周三 20:00 空闲，周六 10:00 空闲', () => {
  const { isPeak } = mod
  if (isPeak(PEAK_MS) !== true) throw new Error('周三 10:00 应为高峰')
  if (isPeak(OFF_MS) !== false) throw new Error('周三 20:00 应为空闲')
  if (isPeak(WEEKEND_MS) !== false) throw new Error('周六应为空闲')
})

test('flash 空闲价：仅输出 1,000,000 tokens = 0.60 USD × 6.77 = ¥4.062', () => {
  const { foldUsage, emptyLedger } = mod
  const state = Object.assign(emptyLedger('deepseek-v4.1-flash'), { key: 'flash' })
  const next = foldUsage(state, usageEvent({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 1000000 }, OFF_MS), 6.77)
  const want = 0.6 * 6.77
  if (!approx(next.cost, want, 1e-6)) throw new Error('期望 ' + want + '，实际 ' + next.cost)
  if (next.calls !== 1) throw new Error('调用次数应为 1')
  if (next.key !== 'flash') throw new Error('档位应为 flash')
})

test('同一份用量在高峰正好是空闲的 2 倍', () => {
  const { foldUsage, emptyLedger } = mod
  const usage = { uncachedInputTokens: 1000000, cacheReadTokens: 500000, outputTokens: 200000 }
  const base = Object.assign(emptyLedger('deepseek-v4-pro'), { key: 'pro' })
  const off = foldUsage(base, usageEvent(usage, OFF_MS), 6.77)
  const peak = foldUsage(base, usageEvent(usage, PEAK_MS), 6.77)
  if (!approx(peak.cost, off.cost * 2, 1e-6)) throw new Error('高峰应为空闲 2 倍：' + peak.cost + ' vs ' + off.cost)
})

test('pro/flash 单价表与官方一致，且费用等于按单价复算的结果', () => {
  const { foldUsage, emptyLedger, pricingOf } = mod
  const rate = 6.77
  const p = pricingOf(rate)
  // 官方 USD/百万 tokens（空闲档），折算人民币
  const usd = { flash: { hit: 0.003, miss: 0.15, out: 0.6 }, pro: { hit: 0.022, miss: 0.66, out: 1.98 } }
  for (const key of ['flash', 'pro']) {
    for (const field of ['hit', 'miss', 'out']) {
      if (!approx(p[key].off.cny[field], usd[key][field] * rate, 1e-9)) {
        throw new Error(key + '.' + field + ' 空闲单价不符：' + p[key].off.cny[field])
      }
    }
    // 高峰 = 空闲 × 2
    for (const field of ['hit', 'miss', 'out']) {
      if (!approx(p[key].peak.cny[field], p[key].off.cny[field] * 2, 1e-9)) {
        throw new Error(key + '.' + field + ' 高峰价应为空闲 2 倍')
      }
    }
  }

  const usage = { uncachedInputTokens: 100000, cacheReadTokens: 10000, outputTokens: 50000 }
  const expected = (key) =>
    (10000 * p[key].off.cny.hit + 100000 * p[key].off.cny.miss + 50000 * p[key].off.cny.out) / 1e6
  const model = { flash: 'deepseek-v4.1-flash', pro: 'deepseek-v4-pro' }
  for (const key of ['flash', 'pro']) {
    const got = foldUsage(Object.assign(emptyLedger(model[key]), { key }), usageEvent(usage, OFF_MS), rate)
    if (!approx(got.cost, expected(key), 1e-9)) {
      throw new Error(key + ' 费用不符：期望 ' + expected(key) + '，实际 ' + got.cost)
    }
  }
})

test('未命中兜底：inputTokens 别名等价于 uncachedInputTokens', () => {
  const { foldUsage, emptyLedger } = mod
  const state = Object.assign(emptyLedger('deepseek-v4.1-flash'), { key: 'flash' })
  const a = foldUsage(state, usageEvent({ uncachedInputTokens: 1000, outputTokens: 10 }, OFF_MS), 6.77)
  const b = foldUsage(state, usageEvent({ inputTokens: 1000, outputTokens: 10 }, OFF_MS), 6.77)
  if (!approx(a.cost, b.cost, 1e-12)) throw new Error('别名应等价')
  if (a.miss !== 1000 || b.miss !== 1000) throw new Error('未命中应为 1000')
})

test('没有 usage 的事件不改变账本（返回同一引用）', () => {
  const { foldUsage, emptyLedger } = mod
  const state = Object.assign(emptyLedger('deepseek-v4.1-flash'), { key: 'flash' })
  const same = foldUsage(state, { type: 'assistant/message', seq: 2, time: OFF_MS, data: { turn: 1, step: 1 } }, 6.77)
  if (same !== state) throw new Error('无用量时不应产生新状态')
})

test('多次调用累加，且峰谷分别记账', () => {
  const { foldUsage, emptyLedger } = mod
  let state = Object.assign(emptyLedger('deepseek-v4-pro'), { key: 'pro' })
  state = foldUsage(state, usageEvent({ uncachedInputTokens: 1000, outputTokens: 1000 }, PEAK_MS), 6.77)
  state = foldUsage(state, usageEvent({ uncachedInputTokens: 1000, outputTokens: 1000 }, OFF_MS), 6.77)
  if (state.calls !== 2) throw new Error('调用次数应为 2')
  if (!approx(state.cost, state.peakCost + state.offCost, 1e-12)) throw new Error('总额应等于高峰+空闲')
  if (!(state.peakCost > 0 && state.offCost > 0)) throw new Error('峰谷应各自入账')
})

test('request/header 切换模型：后续调用按新模型计价', () => {
  const { modelOfEvent } = mod
  if (modelOfEvent(headerEvent('deepseek-v4-pro', OFF_MS)) !== 'deepseek-v4-pro') throw new Error('未取到模型名')
  if (modelOfEvent(usageEvent({ outputTokens: 1 }, OFF_MS)) !== null) throw new Error('非 header 事件不应返回模型')
})

const failed = []
;(async () => {
  const url = pathToFileURL(path.join(__dirname, 'lib', 'core.js')).href
  mod = await import(url)
  for (const c of cases) {
    try {
      c.fn()
      console.log('  ok   ' + c.name)
    } catch (e) {
      failed.push(c.name + ': ' + (e && e.message ? e.message : String(e)))
      console.log('  FAIL ' + c.name + ' -> ' + (e && e.message ? e.message : String(e)))
    }
  }
  console.log('')
  console.log(cases.length - failed.length + '/' + cases.length + ' passed')
  if (failed.length > 0) process.exit(1)
})()
