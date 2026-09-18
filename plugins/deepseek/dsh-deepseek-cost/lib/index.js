/**
 * dsh-deepseek-cost — Host 半边（静态 bundle 插件）
 *
 * 职责：
 *  1. 折叠会话日志里的用量事件，按「真实模型 + 调用发生时的北京峰谷时段」累计本会话费用；
 *  2. 通过 ctx.sessionProjections 把账本发布给浏览器半边（客户端 slot props 的 useProjection）；
 *  3. 通过 ctx.webServer 暴露 /dsh-deepseek-cost/snapshot，供胶囊轮询（含账户余额）。
 *
 * 价格来源：https://api-docs.deepseek.com/quick_start/pricing
 * 官方以 USD / 百万 tokens 计价，高峰价 = 空闲价 × 2：
 *   flash : 命中 0.003 / 0.006，未命中 0.15 / 0.30，输出 0.60 / 1.20
 *   v4-pro: 命中 0.022 / 0.044，未命中 0.66 / 1.32，输出 1.98 / 3.96
 * 高峰时段（官方 UTC 周一~周五 01:00-04:00、06:00-10:00）
 * 换算成北京时间即 09:00-12:00、14:00-18:00，其余（含周末全天）为空闲。
 */
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  KEY_LABEL,
  modelKey,
  pricingOf,
  bjParts,
  isPeak,
  buckets,
  modelOfEvent,
  usageBuckets,
  foldUsage,
  emptyLedger
} from './core.js'

export const name = 'dsh-deepseek-cost'

/**
 * 硬依赖：
 *  - sessionProjections：把每会话账本发布给浏览器半边；
 *  - connection：在共享 /api 通道上注册带鉴权的精确 Fetch 路由（余额等敏感数据不能挂裸路由）。
 * subprocess / credentials 为可选读取（余额用）。
 */
export const inject = ['sessionProjections', 'connection']

export const Config = Schema.object({
  rate: Schema.number().default(6.77).description('1 USD 折合人民币，仅用于展示'),
  balanceOkMs: Schema.number().default(60000).description('余额成功缓存时长（毫秒）'),
  balanceErrMs: Schema.number().default(10000).description('余额失败重试间隔（毫秒）'),
  snapshotPath: Schema.string().default('/api/dsh-deepseek-cost/snapshot').description('快照路由路径（必须位于 /api 下）')
})

const PROJ_KEY = 'dshDeepseekCost'
const CURL_CWD = 'C:\\Users\\Public'

/* ------------------------------------------------------------------
 * 计价与折叠的纯函数已下沉到 ./core.js（零依赖），便于单测在无依赖环境运行。
 * 本文件只保留需要运行时的部分：Config(schemastery)、投影 zod schema、
 * 余额读取、路由注册与 apply()。
 * ------------------------------------------------------------------ */

/**
 * 投影单元契约要求 `stateSchema` 与 `wire.viewSchema`（zod）：框架会在
 * 恢复持久化断点与下发客户端视图前调用它们的 `.parse()`。缺失时框架会
 * 在读取历史会话时报 "Cannot read properties of undefined (reading 'parse')"。
 */
const ledgerStateSchema = z.object({
  cost: z.number(),
  hit: z.number(),
  miss: z.number(),
  out: z.number(),
  calls: z.number(),
  model: z.string(),
  key: z.string(),
  peakCost: z.number(),
  offCost: z.number(),
  updatedAt: z.number()
})

const ledgerViewSchema = z.object({
  ok: z.boolean(),
  cost: z.number(),
  peakCost: z.number(),
  offCost: z.number(),
  hit: z.number(),
  miss: z.number(),
  out: z.number(),
  calls: z.number(),
  model: z.string(),
  key: z.string()
})

/* ------------------------------------------------------------------
 * 余额：动态包沙箱禁用全局 fetch，web.fetch 不转发 Authorization 头，
 * shell 执行器会给命令套会话 sandbox 模式（本机无可用后端 → 直接拒绝），
 * 所以走 ctx.subprocess：它只收一份完全指定的 spawn 清单，不套会话沙箱。
 * 鉴权值直接写进 curl config（经 stdin 交给子进程），不进 argv、不落盘。
 * ------------------------------------------------------------------ */

/** GET /user/balance 响应：正常为 balance_infos，鉴权失败为 { error: { message } } */
function parseBalance(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const infos = payload.balance_infos
  if (!Array.isArray(infos) || infos.length === 0) return null
  let pick = null
  for (const info of infos) {
    if (info && String(info.currency || '').toUpperCase() === 'CNY') {
      pick = info
      break
    }
  }
  if (pick === null) pick = infos[0]
  if (pick === null || typeof pick !== 'object') return null
  const total = Number(pick.total_balance)
  if (!isFinite(total)) return null
  const granted = Number(pick.granted_balance)
  const topped = Number(pick.topped_up_balance)
  return {
    currency: String(pick.currency || ''),
    total,
    granted: isFinite(granted) ? granted : 0,
    topped: isFinite(topped) ? topped : 0,
    available: payload.is_available !== false
  }
}

/** 从响应体取业务错误文案（比裸退出码有用得多） */
function apiErrorMessage(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  const err = payload.error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message
  if (typeof payload.message === 'string') return payload.message
  return ''
}

function readCollected(handle) {
  const c = handle && handle.collected ? handle.collected : null
  const out = { stdout: '', stderr: '' }
  try {
    if (c && c.stdout) out.stdout = c.stdout.readFrom(0).text || ''
  } catch (e) {}
  try {
    if (c && c.stderr) out.stderr = c.stderr.readFrom(0).text || ''
  } catch (e) {}
  return out
}

class BalanceReader {
  constructor(ctx, options) {
    this.ctx = ctx
    this.okMs = options.balanceOkMs
    this.errMs = options.balanceErrMs
    this.ok = { at: 0, value: null }
    this.err = { at: 0, text: '' }
    this.inflight = null
    // 未声明的服务属性读取在 Cordis 里会抛（cannot get property ... without inject），
    // 所以先探测一次，把结果记成布尔值；探针本身就是按需 inject。
    this.subprocess = undefined
    this.credentials = null
    this.probe = this.ctx.inject(['subprocess'], (scoped) => {
      this.subprocess = scoped.subprocess
      try {
        // credentials 为可选：只有拿到作用域 ctx 才敢读
        const creds = scoped.get('credentials')
        this.credentials = creds === undefined ? null : creds
      } catch (e) {
        this.credentials = null
      }
      return () => {
        this.subprocess = undefined
        this.credentials = null
      }
    })
  }

  fail(text) {
    this.err = { at: Date.now(), text: String(text).slice(0, 160) }
    return { value: null, error: this.err.text }
  }

  /** @returns {Promise<{value: object|null, error: string}>} */
  read() {
    const now = Date.now()
    if (this.ok.value !== null && now - this.ok.at < this.okMs) {
      return Promise.resolve({ value: this.ok.value, error: '' })
    }
    if (this.err.text !== '' && now - this.err.at < this.errMs) {
      return Promise.resolve({ value: null, error: this.err.text })
    }
    if (this.inflight !== null) return this.inflight
    this.inflight = this.fetchOnce().then(
      (out) => {
        this.inflight = null
        return out
      },
      (e) => {
        this.inflight = null
        return this.fail(e && e.message ? e.message : '执行失败')
      }
    )
    return this.inflight
  }

  async fetchOnce() {
    const sub = this.subprocess
    if (sub === undefined || typeof sub.spawn !== 'function') {
      return this.fail('subprocess 服务不可用')
    }
    let key = ''
    try {
      const creds = this.credentials
      if (creds !== null && typeof creds.resolve === 'function') {
        const resolved = await creds.resolve('DEEPSEEK_API_KEY')
        if (resolved && typeof resolved.value === 'string') key = resolved.value
      }
    } catch (e) {
      key = ''
    }
    if (key === '') return this.fail('未配置 DEEPSEEK_API_KEY')

    const config =
      'url = "https://api.deepseek.com/user/balance"\n' +
      'header = "Authorization: Bearer ' + key.replace(/["\\\r\n]/g, '') + '"\n'

    const exe = await sub.resolveExecutable('curl')
    const handle = sub.spawn({
      argv: [exe, '--silent', '--show-error', '--config', '-'],
      cwd: CURL_CWD,
      stdio: {
        stdin: { data: config },
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 16384 }
      },
      graceMs: 2000
    })

    let timer = null
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 12000)
    })
    const done = handle.done
      .then((o) => ({ exitCode: o ? o.exitCode : null }))
      .catch((e) => ({ exitCode: null, error: e && e.message ? e.message : 'spawn 失败' }))
    const outcome = await Promise.race([done, guard])
    if (timer !== null) clearTimeout(timer)

    const io = readCollected(handle)
    if (outcome === null) {
      try {
        handle.terminate()
      } catch (e) {}
      return this.fail('请求超时（12s）')
    }

    // 先看响应体：业务错误（如鉴权失败）也可能带非 0 退出码，而它的提示比裸退出码有用得多。
    const trimmed = String(io.stdout || '').trim()
    let payload = null
    if (trimmed !== '') {
      try {
        payload = JSON.parse(trimmed)
      } catch (e) {
        payload = null
      }
    }
    if (payload !== null) {
      const apiErr = apiErrorMessage(payload)
      if (apiErr !== '') return this.fail(apiErr)
      const parsed = parseBalance(payload)
      if (parsed !== null) {
        this.ok = { at: Date.now(), value: parsed }
        this.err = { at: 0, text: '' }
        return { value: parsed, error: '' }
      }
    }
    if (outcome.exitCode !== 0) {
      const hint = String(io.stderr || '').trim() || String(outcome.error || '')
      return this.fail('curl 退出码 ' + outcome.exitCode + (hint ? '：' + hint.slice(0, 100) : ''))
    }
    return this.fail('响应解析失败：' + trimmed.slice(0, 80))
  }
}

/* ------------------------------------------------------------------
 * 账本：key = sessionId，value = 折叠结果。客户端按 sessionId 取自己的那一格。
 * 每个会话的账本由 request/header 事件先置一次模型，之后每次 assistant/message 折一次。
 * ------------------------------------------------------------------ */
const ledgers = new Map()

function ledgerFor(sessionId) {
  let t = ledgers.get(sessionId)
  if (t === undefined) {
    t = emptyLedger('')
    ledgers.set(sessionId, t)
  }
  return t
}

function seedSession(session, header) {
  let model = ''
  if (header && header.config && typeof header.config.model === 'string') model = header.config.model
  if (!ledgers.has(session.id)) ledgers.set(session.id, emptyLedger(model))
}

export function apply(ctx, config) {
  const rate = typeof config?.rate === 'number' ? config.rate : 6.77
  const snapshotPath =
    typeof config?.snapshotPath === 'string' ? config.snapshotPath : '/api/dsh-deepseek-cost/snapshot'
  const balance = new BalanceReader(ctx, config || {})

  // 1) 投影单元：纯折叠，可从日志重放，重启后自动重建。
  // 护栏：投影契约强制要求 stateSchema / wire.viewSchema；缺失时框架会在读取历史
  // 会话时对 undefined 调 .parse()，把**所有会话的历史加载**一起打崩。
  // 宁可放弃投影（客户端本来就靠 HTTP 路由拿数据），也不能让别人的历史加载挂掉。
  const schemaOk =
    ledgerStateSchema !== undefined &&
    typeof ledgerStateSchema.parse === 'function' &&
    ledgerViewSchema !== undefined &&
    typeof ledgerViewSchema.parse === 'function'
  if (!schemaOk) {
    ctx.logger?.warn?.('dsh-deepseek-cost: 投影 schema 不可用（zod 未解析？），已跳过投影注册；费用胶囊仍可用')
  } else {
    ctx.sessionProjections.register({
      key: PROJ_KEY,
      stateVersion: 2,
      stateSchema: ledgerStateSchema,
      init: (header) => {
        let model = ''
        if (header && header.config && typeof header.config.model === 'string') model = header.config.model
        return emptyLedger(model)
      },
      apply: (state, event) => {
        const seen = modelOfEvent(event)
        if (seen !== null) {
          // 路由变了：只记住模型，账本不变（新对象让后续 fold 用新模型计价）
          return state.model === seen ? state : Object.assign({}, state, { model: seen, key: modelKey(seen) || '' })
        }
        return foldUsage(state, event, rate)
      },
      wire: {
        viewSchema: ledgerViewSchema,
        view: (state) => ({
          ok: state.calls > 0,
          cost: state.cost,
          peakCost: state.peakCost,
          offCost: state.offCost,
          hit: state.hit,
          miss: state.miss,
          out: state.out,
          calls: state.calls,
          model: state.model || '',
          key: state.key || ''
        })
      }
    })
  }

  // 2) 会话创建时先落一格，避免第一次读取时缺键
  ctx.on('session/created', (session) => {
    seedSession(session, session.header)
    // 兜底：账本不会无限增长
    if (ledgers.size > 200) {
      const keys = Array.from(ledgers.keys()).slice(0, ledgers.size - 200)
      for (const key of keys) ledgers.delete(key)
    }
  })

  // 3) 快照路由：客户端轮询用（含余额）。
  // 走 connection.fetch 而不是裸 webServer.register —— 前者在共享 /api 通道上，
  // 由 Connection 施加 Host/Origin 与浏览器鉴权；余额属于敏感数据，不能挂裸路由。
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: snapshotPath,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let sessionId = ''
        try {
          sessionId = new URL(request.url).searchParams.get('sessionId') || ''
        } catch (e) {
          sessionId = ''
        }
        const ledger = ledgers.get(sessionId)
        const bal = await balance.read()
        const now = Date.now()
        const prices = pricingOf(rate)
        const payload = {
          tier: isPeak(now) ? 'peak' : 'off',
          bjTime: bjParts(now).text,
          rate,
          table: {
            flash: { label: KEY_LABEL.flash, off: prices.flash.off.cny, peak: prices.flash.peak.cny },
            pro: { label: KEY_LABEL.pro, off: prices.pro.off.cny, peak: prices.pro.peak.cny }
          },
          balance: {
            ok: bal.value !== null,
            total: bal.value ? bal.value.total : 0,
            granted: bal.value ? bal.value.granted : 0,
            topped: bal.value ? bal.value.topped : 0,
            currency: bal.value ? bal.value.currency : '',
            available: bal.value ? bal.value.available : true
          }
        }
        if (bal.value === null) payload.balanceError = bal.error
        if (ledger !== undefined) {
          payload.ok = true
          payload.cost = ledger.cost
          payload.peakCost = ledger.peakCost
          payload.offCost = ledger.offCost
          payload.hit = ledger.hit
          payload.miss = ledger.miss
          payload.out = ledger.out
          payload.calls = ledger.calls
          payload.model = ledger.model
          payload.key = ledger.key
        } else {
          payload.ok = false
        }
        return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
      }
    })
  )

  // 4) 日志折叠在内存账本上的镜像：路由随时读到最新值（投影里的值只服务客户端首屏）
  ctx.on('session/event', (session, event) => {
    const seen = modelOfEvent(event)
    if (seen !== null) {
      const t = ledgerFor(session.id)
      if (t.model !== seen) {
        t.model = seen
        t.key = modelKey(seen) || ''
      }
      return
    }
    if (!event || event.type !== 'assistant/message') return
    const data = event.data
    if (!data || !data.usage) return
    const prev = ledgerFor(session.id)
    const next = foldUsage(prev, event, rate)
    if (next !== prev) ledgers.set(session.id, next)
  })

  ctx.logger?.info?.('dsh-deepseek-cost: 费用胶囊已挂载（%s）', snapshotPath)
}

/** 纯函数导出，仅供离线单测使用（运行时不依赖）。 */
export const __test__ = { modelKey, pricingOf, isPeak, bjParts, buckets, usageBuckets, foldUsage, emptyLedger, modelOfEvent }
