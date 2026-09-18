/**
 * dsh-deepseek-cost — 纯函数核心（零依赖）
 *
 * 这里放的是**不依赖任何外部包**的计价与折叠逻辑：模型判定、价格表、
 * 北京峰谷时段、token 桶归一、账本折叠。
 *
 * 为什么单独成文件：`core.test.cjs` 要在不安装任何依赖的环境里跑
 * （CI 只做 checkout，没有 @deepseek-ai/* 与 zod）。如果单测直接 import
 * `lib/index.js`，就会连带加载 schemastery/zod，导致
 * `ERR_MODULE_NOT_FOUND`。把纯函数切出来，单测只 import 本文件即可。
 *
 * 因此约定：**本文件不得 import 任何外部包**，只允许纯计算。
 * 价格来源：https://api-docs.deepseek.com/quick_start/pricing
 * 官方以 USD / 百万 tokens 计价，高峰价 = 空闲价 × 2：
 *   flash : 命中 0.003 / 0.006，未命中 0.15 / 0.30，输出 0.60 / 1.20
 *   v4-pro: 命中 0.022 / 0.044，未命中 0.66 / 1.32，输出 1.98 / 3.96
 * 高峰时段（官方 UTC 周一~周五 01:00-04:00、06:00-10:00）
 * 换算成北京时间即 09:00-12:00、14:00-18:00，其余（含周末全天）为空闲。
 */

export const KEY_LABEL = {
  flash: 'DeepSeek-V4.1-Flash',
  pro: 'DeepSeek-V4-Pro'
}

function tier(rate, hit, miss, out) {
  return { hit: hit, miss: miss, out: out, cny: { hit: hit * rate, miss: miss * rate, out: out * rate } }
}

/** 模型名 -> 计价档位；非 DeepSeek 模型返回 null（不计价） */
export function modelKey(model) {
  if (typeof model !== 'string' || !/deepseek/i.test(model)) return null
  return /pro/i.test(model) ? 'pro' : 'flash'
}

export function pricingOf(rate) {
  return {
    flash: { off: tier(rate, 0.003, 0.15, 0.6), peak: tier(rate, 0.006, 0.3, 1.2) },
    pro: { off: tier(rate, 0.022, 0.66, 1.98), peak: tier(rate, 0.044, 1.32, 3.96) }
  }
}

/** 北京时间拆解：固定 UTC+8 偏移，与运行环境时区无关 */
export function bjParts(ms) {
  const d = new Date((typeof ms === 'number' ? ms : Date.now()) + 8 * 3600 * 1000)
  const day = d.getUTCDay()
  const hour = d.getUTCHours()
  return {
    day,
    hour,
    text: ('0' + hour).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2),
    weekend: day === 0 || day === 6
  }
}

/** 高峰 = 周一~周五 09:00-12:00、14:00-18:00 */
export function isPeak(ms) {
  const p = bjParts(ms)
  if (p.weekend) return false
  return (p.hour >= 9 && p.hour < 12) || (p.hour >= 14 && p.hour < 18)
}

function num(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0
}

/**
 * TokenUsage -> 计费明细。DeepSeek 适配器把 uncachedInputTokens 映射为「非缓存命中」输入，
 * 故未命中以它为准；只有它缺失时才用 cacheWriteTokens 兜底，避免重复计费。
 */
export function buckets(usage) {
  const input = num(usage && usage.uncachedInputTokens)
  const hit = num(usage && usage.cacheReadTokens)
  const write = num(usage && usage.cacheWriteTokens)
  const out = num(usage && usage.outputTokens)
  const miss = input > 0 ? input : write
  return { hit, miss, out }
}

/** 从 request/header 事件取出本次请求的模型名 */
export function modelOfEvent(event) {
  if (!event || event.type !== 'request/header') return null
  const data = event.data
  const header = data && data.header
  const config = header && header.config
  if (!config || typeof config !== 'object') return null
  const model = config.model
  return typeof model === 'string' && model !== '' ? model : null
}

/** 用量的原始桶字段在不同版本里命名可能不同，这里做一次兼容读取 */
export function usageBuckets(usage) {
  if (!usage || typeof usage !== 'object') return { hit: 0, miss: 0, out: 0 }
  const normalized =
    usage.uncachedInputTokens !== undefined
      ? usage
      : {
          uncachedInputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens
        }
  return buckets(normalized)
}

/** 把一次模型调用的用量与当时的模型/时段折进账本，返回新账本（无变化时返回原引用） */
export function foldUsage(prev, event, rate) {
  if (!event || event.type !== 'assistant/message') return prev
  const data = event.data
  if (!data || !data.usage) return prev
  const model = prev.model
  const key = modelKey(model)
  if (key === null) return prev
  const at = typeof event.time === 'number' ? event.time : Date.now()
  const peak = isPeak(at)
  const b = usageBuckets(data.usage)
  const t = (pricingOf(rate)[key][peak ? 'peak' : 'off']).cny
  const cost = (b.hit * t.hit + b.miss * t.miss + b.out * t.out) / 1e6
  const next = {
    cost: prev.cost + cost,
    hit: prev.hit + b.hit,
    miss: prev.miss + b.miss,
    out: prev.out + b.out,
    calls: prev.calls + 1,
    model,
    key,
    peakCost: prev.peakCost + (peak ? cost : 0),
    offCost: prev.offCost + (peak ? 0 : cost),
    updatedAt: at
  }
  return next
}

export function emptyLedger(model) {
  return { cost: 0, hit: 0, miss: 0, out: 0, calls: 0, model: model || '', key: '', peakCost: 0, offCost: 0, updatedAt: 0 }
}
