/**
 * dsh-deepseek-cost — Client 半边（静态 bundle 插件）
 *
 * 静态 bundle 的浏览器半边不是 ESM：必须自己调 window.__ModuleLoader__.load({id, factory})，
 * factory 收到模块表的同步 require，返回插件对象 { name, inject, apply }。
 * 这里只用种子模块 react（无需 dsh.client.inject 边）。
 *
 * 数据来源：Host 半边注册的 HTTP 快照路由，按 sessionId 轮询。
 */
window.__ModuleLoader__.load({
	id: 'dsh-deepseek-cost',
	factory: (require) => {
		var React = require('react')

		var NS = 'dsh-deepseek-cost'
		var SNAPSHOT_PATH = '/api/dsh-deepseek-cost/snapshot'
		var RATE_FALLBACK = 6.77
		var BALANCE_EVERY_MS = 30000

		var FALLBACK_TABLE = {
			flash: {
				label: 'DeepSeek-V4.1-Flash',
				off: { hit: 0.003 * RATE_FALLBACK, miss: 0.15 * RATE_FALLBACK, out: 0.6 * RATE_FALLBACK },
				peak: { hit: 0.006 * RATE_FALLBACK, miss: 0.3 * RATE_FALLBACK, out: 1.2 * RATE_FALLBACK }
			},
			pro: {
				label: 'DeepSeek-V4-Pro',
				off: { hit: 0.022 * RATE_FALLBACK, miss: 0.66 * RATE_FALLBACK, out: 1.98 * RATE_FALLBACK },
				peak: { hit: 0.044 * RATE_FALLBACK, miss: 1.32 * RATE_FALLBACK, out: 3.96 * RATE_FALLBACK }
			}
		}

		// 颜色全部走主题变量，跟随「设置 → 外观」的浅色/深色自动适配。
		var CSS = [
			'.dsc-root{position:relative;display:inline-flex;align-items:center;font-size:12px;line-height:1;',
			'font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);}',
			'.dsc-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:999px;',
			'background:transparent;border:1px solid transparent;white-space:nowrap;',
			'transition:background .12s ease,border-color .12s ease;}',
			'.dsc-root:hover .dsc-chip{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);}',
			'.dsc-dot{width:6px;height:6px;border-radius:50%;flex:none;}',
			'.dsc-dot.peak{background:var(--dsw-alias-state-error-primary);}',
			'.dsc-dot.off{background:var(--dsw-alias-state-success-primary);}',
			'.dsc-amt{font-weight:600;color:var(--dsw-alias-label-primary);}',
			'.dsc-bal{color:var(--dsw-alias-label-secondary);opacity:.85;}',
			'.dsc-div{width:1px;height:11px;background:var(--dsw-alias-border-l1);}',
			'.dsc-tip{position:absolute;right:0;bottom:calc(100% + 8px);z-index:60;width:246px;box-sizing:border-box;',
			'padding:10px 12px;border-radius:10px;display:none;font-size:11.5px;line-height:1.65;',
			'background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
			'border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.22);}',
			'.dsc-root:hover .dsc-tip{display:block;}',
			'.dsc-hd{font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;}',
			'.dsc-hd span:last-child{font-weight:400;color:var(--dsw-alias-label-secondary);}',
			'.dsc-tip table{width:100%;border-collapse:collapse;}',
			'.dsc-tip th,.dsc-tip td{padding:1px 0;text-align:right;white-space:nowrap;}',
			'.dsc-tip th:first-child,.dsc-tip td:first-child{text-align:left;font-weight:400;color:var(--dsw-alias-label-secondary);}',
			'.dsc-tip th{font-weight:500;color:var(--dsw-alias-label-secondary);opacity:.8;',
			'border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:3px;}',
			'.dsc-tip th.on,.dsc-tip td.on{color:var(--dsw-alias-brand-primary);font-weight:600;opacity:1;}',
			'.dsc-row{display:flex;justify-content:space-between;gap:8px;margin-top:3px;}',
			'.dsc-row span:first-child{color:var(--dsw-alias-label-secondary);}',
			'.dsc-sep{height:1px;margin:7px 0;background:var(--dsw-alias-border-l1);}',
			'.dsc-note{margin-top:6px;color:var(--dsw-alias-label-secondary);opacity:.85;font-size:10.5px;line-height:1.5;}',
			'.dsc-warn{color:var(--dsw-alias-state-warn-primary);}'
		].join('')

		function fmtCny(v) {
			if (typeof v !== 'number' || !isFinite(v) || v <= 0) return '\u00A50.0000'
			if (v < 0.01) return '\u00A5' + v.toFixed(4)
			if (v < 1) return '\u00A5' + v.toFixed(3)
			return '\u00A5' + v.toFixed(2)
		}

		function fmtTokens(n) {
			if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0'
			if (n >= 1e8) return (n / 1e8).toFixed(2) + '\u4EBF'
			if (n >= 1e4) return (n / 1e4).toFixed(2) + '\u4E07'
			if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
			return String(n)
		}

		// 北京时间（本地计算，每秒刷新，不走网络）
		function bjNow() {
			var d = new Date(Date.now() + 8 * 3600 * 1000)
			var day = d.getUTCDay()
			var hour = d.getUTCHours()
			var weekend = day === 0 || day === 6
			var peak = !weekend && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
			return { peak: peak, time: ('0' + hour).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) }
		}

		function CostChip(props) {
			var state = React.useState(null)
			var data = state[0]
			var setData = state[1]
			var clock = React.useState(bjNow())
			var bj = clock[0]
			var setBj = clock[1]

			React.useEffect(function () {
				var el = document.createElement('style')
				el.setAttribute('data-dsh-plugin', NS)
				el.textContent = CSS
				document.head.appendChild(el)
				return function () {
					try {
						document.head.removeChild(el)
					} catch (e) {}
				}
			}, [])

			var sessionId = String(props.sessionId || '')
			React.useEffect(
				function () {
					var alive = true
					var stop = null
					var startedAt = Date.now()
					var fails = 0

					function tick() {
						if (!alive) return
						setBj(bjNow())
						fetch(SNAPSHOT_PATH + '?sessionId=' + encodeURIComponent(sessionId), {
							credentials: 'same-origin',
							headers: { accept: 'application/json' }
						})
							.then(function (r) {
								return r.ok ? r.json() : null
							})
							.then(function (next) {
								if (!alive) return
								fails = 0
								setData(next && typeof next === 'object' ? next : null)
							})
							.catch(function () {
								fails += 1
								if (fails === 6) console.error('dsh-deepseek-cost: 无法读取费用快照（继续重试）')
							})
						// 前 30 秒每秒轮询，之后降到 5 秒
						stop = setTimeout(tick, Date.now() - startedAt < 30000 ? 1000 : 5000)
					}

					tick()
					return function () {
						alive = false
						if (stop) clearTimeout(stop)
					}
				},
				[sessionId]
			)

			if (data === null || typeof data !== 'object') return null
			var hasCost = data.ok === true
			var bal = data.balance && typeof data.balance === 'object' && data.balance.ok === true ? data.balance : null
			// 既无消费也无余额时不占位
			if (!hasCost && bal === null && !data.balanceError) return null

			var table = data.table && data.table.flash ? data.table : FALLBACK_TABLE
			var key = data.key === 'pro' ? 'pro' : 'flash'
			var prices = table[key] || table.flash
			var tierKey = bj.peak ? 'peak' : 'off'
			var rows = [
				['\u8F93\u5165 \u00B7 \u7F13\u5B58\u547D\u4E2D', prices.off.hit, prices.peak.hit],
				['\u8F93\u5165 \u00B7 \u7F13\u5B58\u672A\u547D\u4E2D', prices.off.miss, prices.peak.miss],
				['\u8F93\u51FA', prices.off.out, prices.peak.out]
			]

			var stat = function (k, v, warn) {
				return React.createElement(
					'div',
					{ className: 'dsc-row', key: k },
					React.createElement('span', null, k),
					React.createElement('span', { className: warn ? 'dsc-warn' : '' }, v)
				)
			}

			var tipParts = [
				React.createElement(
					'div',
					{ className: 'dsc-hd', key: 'hd' },
					React.createElement('span', null, prices.label),
					React.createElement(
						'span',
						null,
						(bj.peak ? '\u{1F534}\u9AD8\u5CF0' : '\u{1F7E2}\u7A7A\u95F2') + ' \u00B7 \u5317\u4EAC ' + bj.time
					)
				),
				React.createElement(
					'table',
					{ key: 'tb' },
					React.createElement(
						'tbody',
						null,
						React.createElement(
							'tr',
							null,
							React.createElement('th', null, '\u9879\u76EE\uFF08\u00A5/\u767E\u4E07 tokens\uFF09'),
							React.createElement('th', { className: tierKey === 'off' ? 'on' : '' }, '\u7A7A\u95F2'),
							React.createElement('th', { className: tierKey === 'peak' ? 'on' : '' }, '\u9AD8\u5CF0')
						),
						rows.map(function (r, i) {
							return React.createElement(
								'tr',
								{ key: 'r' + i },
								React.createElement('td', null, r[0]),
								React.createElement('td', { className: tierKey === 'off' ? 'on' : '' }, r[1].toFixed(2)),
								React.createElement('td', { className: tierKey === 'peak' ? 'on' : '' }, r[2].toFixed(2))
							)
						})
					)
				),
				React.createElement('div', { className: 'dsc-sep', key: 'sp' })
			]

			if (bal !== null) {
				tipParts.push(stat('\u8D26\u6237\u4F59\u989D', fmtCny(bal.total) + ' ' + (bal.currency || ''), bal.available === false))
				if (bal.topped > 0) tipParts.push(stat('\u5176\u4E2D\u5145\u503C', fmtCny(bal.topped)))
				if (bal.granted > 0) tipParts.push(stat('\u5176\u4E2D\u8D60\u9001', fmtCny(bal.granted)))
				if (bal.available === false) {
					tipParts.push(
						React.createElement(
							'div',
							{ className: 'dsc-note dsc-warn', key: 'bw' },
							'\u8D26\u6237\u4F59\u989D\u4E0D\u8DB3\u6216\u4E0D\u53EF\u7528'
						)
					)
				}
				tipParts.push(React.createElement('div', { className: 'dsc-sep', key: 'sp2' }))
			} else if (data.balanceError) {
				tipParts.push(
					React.createElement(
						'div',
						{ className: 'dsc-note dsc-warn', key: 'be' },
						'\u4F59\u989D\u8BFB\u53D6\u5931\u8D25\uFF1A' + String(data.balanceError)
					)
				)
				tipParts.push(React.createElement('div', { className: 'dsc-sep', key: 'sp3' }))
			}

			if (hasCost) {
				tipParts.push(stat('\u672C\u4F1A\u8BDD\u8D39\u7528', fmtCny(data.cost)))
				tipParts.push(stat('\u7F13\u5B58\u547D\u4E2D', fmtTokens(data.hit)))
				tipParts.push(stat('\u7F13\u5B58\u672A\u547D\u4E2D', fmtTokens(data.miss)))
				tipParts.push(stat('\u8F93\u51FA', fmtTokens(data.out)))
				tipParts.push(stat('\u8C03\u7528\u6B21\u6570', String(data.calls || 0)))
				tipParts.push(
					stat('\u65F6\u6BB5\u5206\u5E03', '\u9AD8\u5CF0 ' + fmtCny(data.peakCost) + ' \u00B7 \u7A7A\u95F2 ' + fmtCny(data.offCost))
				)
			}

			tipParts.push(
				React.createElement(
					'div',
					{ className: 'dsc-note', key: 'nt' },
					'\u6309\u6BCF\u6B21\u8C03\u7528\u53D1\u8D77\u65F6\u523B\u7684\u5355\u4EF7\u9010\u6B21\u8BA1\u4EF7\u540E\u7D2F\u52A0\u3002' +
						'\u9AD8\u5CF0\uFF1A\u5317\u4EAC\u65F6\u95F4\u5468\u4E00~\u5468\u4E94 09:00-12:00\u300114:00-18:00\uFF0C\u5176\u4F59\uFF08\u542B\u5468\u672B\u5168\u5929\uFF09\u7A7A\u95F2\u3002' +
						'\u6309 1 USD = ' +
						(data.rate || RATE_FALLBACK) +
						' CNY \u6298\u7B97\uFF0C\u4EC5\u4F9B\u53C2\u8003\u3002'
				)
			)

			var chipParts = [React.createElement('span', { className: 'dsc-dot ' + tierKey, key: 'dt' })]
			if (hasCost) {
				chipParts.push(React.createElement('span', { className: 'dsc-amt', key: 'amt' }, fmtCny(data.cost)))
			}
			if (bal !== null) {
				if (hasCost) chipParts.push(React.createElement('span', { className: 'dsc-div', key: 'dv' }))
				chipParts.push(React.createElement('span', { className: 'dsc-bal', key: 'bal' }, '\u4F59\u989D ' + fmtCny(bal.total)))
			}

			return React.createElement(
				'div',
				{ className: 'dsc-root' },
				React.createElement('span', { className: 'dsc-chip' }, chipParts),
				React.createElement('div', { className: 'dsc-tip' }, tipParts)
			)
		}

		function apply(ctx) {
			var slots = ctx.get('slots')
			if (slots === undefined) {
				console.error('dsh-deepseek-cost: slots 服务不可用，费用控件未注册')
				return
			}
			slots.inject('conversation.input.right', function () {
				return slots.register({ name: 'conversation.input.right', id: NS }, CostChip)
			})
		}

		return {
			name: NS,
			inject: ['slots'],
			apply: apply
		}
	}
})
