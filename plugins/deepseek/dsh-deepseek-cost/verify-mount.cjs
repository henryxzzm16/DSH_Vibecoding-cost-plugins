/**
 * dsh-deepseek-cost — 挂载验证（不需要启动 DSH）
 *
 * 用假 ctx 直接调用 host 半边的 apply()，验证三件事：
 *  1. apply 能跑完，并注册了投影单元与 HTTP 路由；
 *  2. 折叠事件后，账本能从投影 view 与快照路由两条路读出来；
 *  3. 没有 subprocess 服务时，余额读取立刻返回而不是挂死，且不阻断费用快照。
 *
 * 运行：node verify-mount.cjs
 */
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const RATE = 6.77
const OFF_MS = Date.UTC(2026, 2, 4, 12, 0, 0) // 北京时间周三 20:00 = 空闲
const PEAK_MS = Date.UTC(2026, 2, 4, 2, 0, 0) // 北京时间周三 10:00 = 高峰

function makeCtx() {
  const state = {
    projections: [],
    routes: [],
    eventHandlers: new Map(),
    services: {},
    injects: [],
    listenerCounts: { on: 0, effect: 0 }
  }
  const base = {
    sessionProjections: {
      register(definition) {
        state.projections.push(definition)
        return () => {}
      }
    },
    connection: {
      fetch: {
        register(route) {
          state.routes.push(route)
          return () => Promise.resolve()
        }
      }
    },
    on(event, handler) {
      state.listenerCounts.on += 1
      const list = state.eventHandlers.get(event) || []
      list.push(handler)
      state.eventHandlers.set(event, list)
      return () => {}
    },
    effect(fn) {
      state.listenerCounts.effect += 1
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    timeout(fn, ms) {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
    interval(fn, ms) {
      const t = setInterval(fn, ms)
      return () => clearInterval(t)
    },
    logger: { info() {}, warn() {}, error() {} }
  }

  // 按需 inject：与 Cordis 行为一致 —— 只有被 inject 的服务才出现在作用域 ctx 上
  function inject(names, callback) {
    state.injects.push(names.join(','))
    const scoped = Object.create(null)
    for (const n of names) {
      if (state.services[n] !== undefined) scoped[n] = state.services[n]
    }
    scoped.get = (key) => state.services[key]
    const dispose = callback(scoped)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }

  // 真 Cordis 里读未声明的服务属性会抛，这里照做，好让这类 bug 离线可复现
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && !prop.startsWith('_') && /^[a-z]/.test(prop)) {
        throw new Error('cannot get property "' + prop + '" without inject')
      }
      return undefined
    }
  })
  base.inject = inject
  base.get = (key) => state.services[key]
  return { ctx, state }
}

function emit(state, event, data) {
  const list = state.eventHandlers.get(event) || []
  for (const handler of list) handler.apply({}, data)
}

function fakeRes() {
  const out = { status: null, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = body ? String(body) : ''
    }
  }
}

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name)
  } else {
    failures.push(name + (detail ? ' -> ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''))
  }
}

;(async () => {
  const url = pathToFileURL(path.join(__dirname, 'lib', 'index.js')).href
  const mod = await import(url)
  const { ctx, state } = makeCtx()

  // apply 必须同步跑完且不抛
  let threw = null
  try {
    mod.apply(ctx, mod.Config({}))
  } catch (e) {
    threw = e
  }
  check('apply() 不抛异常', threw === null, threw && threw.message)

  check('注册了 1 个投影单元', state.projections.length === 1, '实际 ' + state.projections.length)
  const proj = state.projections[0]
  check('投影 key 为 dshDeepseekCost', proj && proj.key === 'dshDeepseekCost', proj && proj.key)
  check('投影带 wire.view', !!(proj && proj.wire && typeof proj.wire.view === 'function'))
  // 框架在恢复断点 / 下发客户端视图前会调用这两个 schema 的 parse()，
  // 缺失时会在读取历史会话时报 "reading 'parse'"，所以必须存在且可解析。
  check('投影带 stateSchema.parse', !!(proj && proj.stateSchema && typeof proj.stateSchema.parse === 'function'))
  check('投影带 wire.viewSchema.parse', !!(proj && proj.wire && proj.wire.viewSchema && typeof proj.wire.viewSchema.parse === 'function'))
  check('stateSchema 能解析初始账本', (() => {
    try {
      proj.stateSchema.parse(proj.init({ config: { model: 'deepseek-v4.1-flash' } }))
      return true
    } catch (e) {
      return false
    }
  })())
  check('wire.viewSchema 能解析视图', (() => {
    try {
      const state = proj.init({ config: { model: 'deepseek-v4.1-flash' } })
      proj.wire.viewSchema.parse(proj.wire.view(state))
      return true
    } catch (e) {
      return false
    }
  })())
  // stateVersion 决定持久化断点是否被沿用：语义变更时必须递增，
  // 否则旧缓存行会被前向应用到新形状上。
  check('stateVersion 已递增到 2', proj.stateVersion === 2, String(proj.stateVersion))
  check('stateSchema 能解析一份真实断点值', (() => {
    try {
      proj.stateSchema.parse({
        cost: 3.605523366779999,
        hit: 91977088,
        miss: 468021,
        out: 310732,
        calls: 438,
        model: 'deepseek-flash',
        key: 'flash',
        peakCost: 0,
        offCost: 3.605523366779999,
        updatedAt: 1789485504811
      })
      return true
    } catch (e) {
      return false
    }
  })())

  check('注册了快照路由', state.routes.length === 1, '实际 ' + state.routes.length)
  const route = state.routes[0]
  check(
    '路由位于 /api 下（受 Connection 鉴权栅栏保护）',
    typeof route.path === 'string' && route.path.startsWith('/api/'),
    route.path
  )
  check('路由只接受 GET', Array.isArray(route.methods) && route.methods.length === 1 && route.methods[0] === 'GET')
  check('路由提供 fetch 实现', typeof route.fetch === 'function')

  async function snapshot(sessionId) {
    const request = new Request('http://localhost' + route.path + '?sessionId=' + encodeURIComponent(sessionId))
    const response = await route.fetch(request)
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch (e) {}
    return { status: response.status, json }
  }

  // 空账本：未消费时应表现为 ok=false（客户端据此不占位）
  let view = proj.wire.view(proj.init({ config: { model: 'deepseek-v4.1-flash' } }))
  check('空账本 ok=false', view.ok === false)
  check('空账本 cost=0', view.cost === 0)

  // 折一次高峰调用
  const session = { id: 'session-test', header: { config: { model: 'deepseek-v4-pro' } } }
  emit(state, 'session/created', [session])
  emit(state, 'session/event', [session, { type: 'request/header', seq: 0, time: PEAK_MS, data: { header: { config: { model: 'deepseek-v4-pro' } } } }])
  emit(state, 'session/event', [
    session,
    {
      type: 'assistant/message',
      seq: 1,
      time: PEAK_MS,
      data: { turn: 1, step: 1, message: {}, stream: [], usage: { uncachedInputTokens: 1000000, cacheReadTokens: 0, outputTokens: 0 } }
    }
  ])

  // 快照路由读出来
  const first = await snapshot('session-test')
  check('路由返回 200', first.status === 200, String(first.status))
  const payload = first.json
  check('路由返回合法 JSON', payload !== null)
  // tier 表示「此刻」的北京时段，与事件发生时刻无关，所以对当前时刻独立复算
  {
    const { isPeak } = mod.__test__
    const expectTier = isPeak(Date.now()) ? 'peak' : 'off'
    check('路由报告的当前时段正确', payload && payload.tier === expectTier, '期望 ' + expectTier + '，实际 ' + (payload && payload.tier))
  }
  check('路由账本已计入费用', payload && payload.ok === true && payload.cost > 0, payload && String(payload.cost))

  // pro 高峰未命中 1,000,000 tokens = 1.32 USD × 6.77
  const want = 1.32 * RATE
  check('金额等于 pro 高峰未命中单价', payload && Math.abs(payload.cost - want) < 1e-6, '期望 ' + want + '，实际 ' + (payload && payload.cost))
  check('模型名已跟随 request/header', payload && payload.model === 'deepseek-v4-pro', payload && payload.model)
  check('档位识别为 pro', payload && payload.key === 'pro', payload && payload.key)
  check('价格表含 flash 与 pro', payload && payload.table && !!payload.table.flash && !!payload.table.pro)

  // 未配 subprocess：余额必须立刻失败，且不吞掉费用
  check('无 subprocess 时余额标记为失败', payload && payload.balance && payload.balance.ok === false)
  check('余额失败原因可读', payload && typeof payload.balanceError === 'string' && payload.balanceError.length > 0, payload && payload.balanceError)
  check(
    '无 subprocess 时给出「服务不可用」而不是抛未声明属性',
    payload && payload.balanceError === 'subprocess 服务不可用',
    payload && payload.balanceError
  )
  check('余额失败不影响费用读取', payload && payload.ok === true && payload.cost > 0)
  check('确实按需 inject 了 subprocess', state.injects.some((n) => n.includes('subprocess')), JSON.stringify(state.injects))

  // 同一路由再查一次：余额失败被缓存，不能重复阻塞
  const t0 = Date.now()
  await snapshot('session-test')
  const elapsed = Date.now() - t0
  check('重复查询余额走失败缓存（<50ms）', elapsed < 50, elapsed + 'ms')

  // 未知会话：不该炸
  const third = await snapshot('nope')
  check('未知 sessionId 返回 ok=false 而非报错', third.json !== null && third.json.ok === false)

  console.log('')
  console.log(failures.length === 0 ? 'all checks passed' : failures.length + ' check(s) failed')
  process.exit(failures.length === 0 ? 0 : 1)
})()
