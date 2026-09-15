/**
 * dsh-deepseek-cost — DeepSeek Harness（DSH）动态 Cordis 插件
 *
 * 在对话输入区实时显示：当前会话的 DeepSeek API 费用 + 账户余额，
 * 按北京时间高峰/空闲分时计价，悬停查看完整价格表。
 *
 * 用法：把本文件全文作为 cordis_define 的 code.host / code.client 提交
 * （两个 return 之前的部分分别对应 Host 半边与 Client 半边）。
 *
 * 价格来源：https://api-docs.deepseek.com/quick_start/pricing
 * 官方以 USD / 百万 tokens 计价，高峰价 = 空闲价 × 2：
 *   flash : 命中 0.003 / 0.006，未命中 0.15 / 0.30，输出 0.60 / 1.20
 *   v4-pro: 命中 0.022 / 0.044，未命中 0.66 / 1.32，输出 1.98 / 3.96
 * 高峰时段（官方 UTC 周一~周五 01:00-04:00、06:00-10:00）
 * 换算成北京时间即 09:00-12:00、14:00-18:00，其余（含周末全天）为空闲。
 */

/* ==================================================================
 * HOST 半边
 * ================================================================== */
var RATE = 6.77; // 1 USD = ? CNY，仅用于展示；改这里即可

function tier(hit, miss, out) {
  return { hit: hit, miss: miss, out: out, cny: { hit: hit * RATE, miss: miss * RATE, out: out * RATE } };
}

var PRICING = {
  flash: { label: 'DeepSeek-V4.1-Flash', match: /flash/i, off: tier(0.003, 0.15, 0.60), peak: tier(0.006, 0.30, 1.20) },
  pro: { label: 'DeepSeek-V4-Pro', match: /pro/i, off: tier(0.022, 0.66, 1.98), peak: tier(0.044, 1.32, 3.96) }
};

// 仅 DeepSeek 模型计价（模型名含 deepseek），其他厂商返回 null
function modelKey(model) {
  if (typeof model !== 'string' || !/deepseek/i.test(model)) return null;
  if (PRICING.pro.match.test(model)) return 'pro';
  return 'flash';
}

// 北京时间拆解：固定 UTC+8 偏移，与运行环境时区无关
function bjParts(ms) {
  var d = new Date((typeof ms === 'number' ? ms : Date.now()) + 8 * 3600 * 1000);
  var day = d.getUTCDay();
  var hour = d.getUTCHours();
  return {
    day: day,
    hour: hour,
    text: ('0' + hour).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2),
    weekend: day === 0 || day === 6
  };
}

// 高峰 = 周一~周五 09:00-12:00、14:00-18:00
function isPeak(ms) {
  var p = bjParts(ms);
  if (p.weekend) return false;
  return (p.hour >= 9 && p.hour < 12) || (p.hour >= 14 && p.hour < 18);
}

function num(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

// TokenUsage -> 计费明细。DeepSeek 适配器把 inputTokens 映射为「非缓存命中」的输入，
// 故未命中以 inputTokens 为准；只有它缺失时才用 cacheWriteTokens 兜底，避免重复计费。
function buckets(u) {
  var input = num(u.inputTokens);
  var hit = num(u.cacheReadTokens);
  var write = num(u.cacheWriteTokens);
  var out = num(u.outputTokens);
  var miss = input > 0 ? input : write;
  return { hit: hit, miss: miss, out: out, total: miss + hit + out };
}

// 单次调用费用（元）
function costOf(usage, key, peak) {
  var t = (PRICING[key] || PRICING.flash)[peak ? 'peak' : 'off'].cny;
  var b = buckets(usage);
  return (b.hit * t.hit + b.miss * t.miss + b.out * t.out) / 1e6;
}

// 高峰+空闲两档人民币单价，供 UI 展示
function priceTable() {
  return {
    flash: { label: PRICING.flash.label, off: PRICING.flash.off.cny, peak: PRICING.flash.peak.cny },
    pro: { label: PRICING.pro.label, off: PRICING.pro.off.cny, peak: PRICING.pro.peak.cny }
  };
}

// curl config 里的字面量：值可能含反斜杠/引号，必须转义后再包一层双引号。
// 注意 curl 8.3+ 默认关闭 config 内的 $VAR 展开，所以 Authorization 头必须写实际值。
function curlQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// GET /user/balance 响应：正常为 balance_infos，鉴权失败为 { error: { message } }
function parseBalance(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  var infos = payload.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) return null;
  var pick = null;
  for (var i = 0; i < infos.length; i++) {
    if (infos[i] && String(infos[i].currency || '').toUpperCase() === 'CNY') { pick = infos[i]; break; }
  }
  if (pick === null) pick = infos[0];
  if (pick === null || typeof pick !== 'object') return null;
  var total = Number(pick.total_balance);
  if (!isFinite(total)) return null;
  var granted = Number(pick.granted_balance);
  var topped = Number(pick.topped_up_balance);
  return {
    currency: String(pick.currency || ''),
    total: total,
    granted: isFinite(granted) ? granted : 0,
    topped: isFinite(topped) ? topped : 0,
    available: payload.is_available !== false
  };
}

// 从响应体取业务错误文案（比裸退出码有用得多）
function apiErrorMessage(payload) {
  if (payload === null || typeof payload !== 'object') return '';
  var err = payload.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  if (typeof payload.message === 'string') return payload.message;
  return '';
}

var tallies = new Map(); // sessionId -> 累计账本

function tallyFor(sessionId) {
  var t = tallies.get(sessionId);
  if (t === undefined) {
    t = { cost: 0, hit: 0, miss: 0, out: 0, calls: 0, model: null, key: null, peakCost: 0, offCost: 0, updatedAt: 0 };
    tallies.set(sessionId, t);
  }
  return t;
}

// 每次模型调用：以「调用发起时刻」的北京时间定价，逐次累加
function record(sessionId, model, usage, at) {
  var key = modelKey(model);
  if (key === null) return null;
  var peak = isPeak(at);
  var cost = costOf(usage, key, peak);
  var b = buckets(usage);
  var t = tallyFor(sessionId);
  t.cost += cost;
  t.hit += b.hit;
  t.miss += b.miss;
  t.out += b.out;
  t.calls += 1;
  t.model = model;
  t.key = key;
  if (peak) t.peakCost += cost; else t.offCost += cost;
  t.updatedAt = at;
  return t;
}

var BALANCE_OK_MS = 60000;
var BALANCE_ERR_MS = 10000;
var CURL_CWD = 'C:\\Users\\Public';
var balanceOk = { at: 0, value: null };
var balanceErr = { at: 0, text: '' };

function balanceFail(text) {
  balanceErr = { at: Date.now(), text: String(text).slice(0, 160) };
  return { value: null, error: balanceErr.text };
}

function readCollected(handle) {
  var c = handle && handle.collected ? handle.collected : null;
  var out = { stdout: '', stderr: '' };
  try { if (c && c.stdout) out.stdout = c.stdout.readFrom(0).text || ''; } catch (e) {}
  try { if (c && c.stderr) out.stderr = c.stderr.readFrom(0).text || ''; } catch (e) {}
  return out;
}

// 余额：动态包沙箱禁用全局 fetch，web.fetch 不转发 Authorization 头，
// shell 执行器会给命令套会话 sandbox 模式（本机无可用后端 → 直接拒绝），
// 所以走 ctx.subprocess：它只收一份完全指定的 spawn 清单，不套会话沙箱。
// 鉴权值直接写进 curl config（经 stdin 交给子进程），不进 argv、不落盘。
function fetchBalance(ctx) {
  var now = Date.now();
  if (balanceOk.value !== null && now - balanceOk.at < BALANCE_OK_MS) {
    return Promise.resolve({ value: balanceOk.value, error: '' });
  }
  if (balanceErr.text !== '' && now - balanceErr.at < BALANCE_ERR_MS) {
    return Promise.resolve({ value: null, error: balanceErr.text });
  }
  if (ctx.subprocess === undefined || typeof ctx.subprocess.spawn !== 'function') {
    return Promise.resolve(balanceFail('subprocess 服务不可用'));
  }

  var handle = null;
  var timer = null;

  var resolveKey = Promise.resolve(null);
  try {
    var creds = ctx.get('credentials');
    if (creds !== undefined && typeof creds.resolve === 'function') resolveKey = creds.resolve('DEEPSEEK_API_KEY');
  } catch (e) {
    resolveKey = Promise.resolve(null);
  }

  return resolveKey.then(function (resolved) {
    var key = resolved && typeof resolved.value === 'string' ? resolved.value : '';
    if (key === '') return balanceFail('未配置 DEEPSEEK_API_KEY');

    var config = 'url = "https://api.deepseek.com/user/balance"\n' +
      'header = "Authorization: Bearer ' + key.replace(/["\\\r\n]/g, '') + '"\n';

    return ctx.subprocess.resolveExecutable('curl').then(function (exe) {
      handle = ctx.subprocess.spawn({
        argv: [exe, '--silent', '--show-error', '--config', '-'],
        cwd: CURL_CWD,
        stdio: {
          stdin: { data: config },
          stdout: { maxBytes: 65536 },
          stderr: { maxBytes: 16384 }
        },
        graceMs: 2000
      });

      var guard = new Promise(function (resolve) {
        timer = ctx.timeout(function () { resolve({ exitCode: null, signal: null, timedOut: true }); }, 12000);
      });

      return Promise.race([
        handle.done.then(function (o) {
          return { exitCode: o ? o.exitCode : null, signal: o ? o.signal : null, timedOut: false };
        }),
        guard
      ]);
    }).then(function (outcome) {
      var io = handle ? readCollected(handle) : { stdout: '', stderr: '' };
      if (timer) { try { timer(); } catch (e) {} timer = null; }
      if (outcome.timedOut) {
        try { handle.terminate(); } catch (e) {}
        return balanceFail('请求超时（12s）');
      }

      // 先看响应体：业务错误（如鉴权失败）也可能带非 0 退出码，
      // 而它的提示比裸退出码有用得多。
      var payload = null;
      var trimmed = String(io.stdout || '').trim();
      if (trimmed !== '') {
        try { payload = JSON.parse(trimmed); } catch (e) { payload = null; }
      }
      if (payload !== null) {
        var apiErr = apiErrorMessage(payload);
        if (apiErr !== '') return balanceFail(apiErr);
        var parsedOk = parseBalance(payload);
        if (parsedOk !== null) {
          balanceOk = { at: Date.now(), value: parsedOk };
          balanceErr = { at: 0, text: '' };
          return { value: parsedOk, error: '' };
        }
      }

      if (outcome.exitCode !== 0) {
        var hint = (io.stderr || '').trim();
        return balanceFail('curl 退出码 ' + outcome.exitCode + (hint ? '：' + hint.slice(0, 100) : ''));
      }
      return balanceFail('响应解析失败：' + trimmed.slice(0, 80));
    });
  }).catch(function (e) {
    if (timer) { try { timer(); } catch (e2) {} timer = null; }
    if (handle) { try { handle.terminate(); } catch (e2) {} }
    return balanceFail((e && e.message) ? e.message : '执行失败');
  });
}

return {
  name: 'dscost',
  inject: ['timer', 'subprocess'],
  apply: function (ctx) {
    // 监听每次流式模型调用：usage 以 chunk 形式下发；
    // 每次尝试（含重试）各走一次 waterfall，因此各自计费一次。
    ctx.on('llm/stream', function (options, next) {
      var source = next();
      var sessionId = options && typeof options.sessionId === 'string' ? options.sessionId : null;
      var model = options && options.model;
      var at = Date.now();

      return (async function* () {
        for await (var chunk of source) {
          try {
            if (sessionId !== null && chunk && chunk.type === 'usage' && chunk.usage) {
              record(sessionId, model, chunk.usage, at);
            }
          } catch (err) {
            // 计价出错绝不影响模型调用本身
          }
          yield chunk;
        }
      })();
    });

    // 客户端每 1~5 秒取一次快照；只回传标量，不传运行时对象
    harness.handle('snapshot', async function (args) {
      var sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : '';
      var now = Date.now();
      var peak = isPeak(now);
      var t = tallies.get(sessionId);
      var b = await fetchBalance(ctx);

      var out = {
        tier: peak ? 'peak' : 'off',
        bjTime: bjParts(now).text,
        rate: RATE,
        table: priceTable(),
        balance: {
          ok: b.value !== null,
          total: b.value ? b.value.total : 0,
          granted: b.value ? b.value.granted : 0,
          topped: b.value ? b.value.topped : 0,
          currency: b.value ? b.value.currency : '',
          available: b.value ? b.value.available : true
        }
      };
      if (b.value === null) out.balanceError = b.error;
      if (t !== undefined) {
        out.ok = true;
        out.cost = t.cost;
        out.peakCost = t.peakCost;
        out.offCost = t.offCost;
        out.hit = t.hit;
        out.miss = t.miss;
        out.out = t.out;
        out.calls = t.calls;
        out.model = t.model || '';
        out.key = t.key || '';
      } else {
        out.ok = false;
      }
      return out;
    });

    // 兜底：会话账本不会无限增长（最多留 200 个）
    ctx.effect(function () {
      return ctx.interval(function () {
        if (tallies.size <= 200) return;
        var keys = Array.from(tallies.keys()).slice(0, tallies.size - 200);
        for (var i = 0; i < keys.length; i++) tallies.delete(keys[i]);
      }, 60000);
    });
  }
};

/* ==================================================================
 * CLIENT 半边
 * ================================================================== */
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
].join('');

function fmtCny(v) {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return '\u00A50.0000';
  if (v < 0.01) return '\u00A5' + v.toFixed(4);
  if (v < 1) return '\u00A5' + v.toFixed(3);
  return '\u00A5' + v.toFixed(2);
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '\u4EBF';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '\u4E07';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// 北京时间（客户端本地计算，每秒刷新，不走网络）
function bjNow() {
  var d = new Date(Date.now() + 8 * 3600 * 1000);
  var day = d.getUTCDay();
  var hour = d.getUTCHours();
  var weekend = day === 0 || day === 6;
  var peak = !weekend && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  return { peak: peak, time: ('0' + hour).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) };
}

return {
  name: 'dscost',
  inject: ['timer'],
  apply: function (ctx) {
    var slots = ctx.get('slots');
    if (slots === undefined) {
      console.error('slots 服务不可用，费用控件未注册');
      return;
    }

    ctx.effect(function () { return styles.insert(CSS); });

    var RATE_FALLBACK = 6.77;
    var FALLBACK_TABLE = {
      flash: {
        label: 'DeepSeek-V4.1-Flash',
        off: { hit: 0.003 * RATE_FALLBACK, miss: 0.15 * RATE_FALLBACK, out: 0.60 * RATE_FALLBACK },
        peak: { hit: 0.006 * RATE_FALLBACK, miss: 0.30 * RATE_FALLBACK, out: 1.20 * RATE_FALLBACK }
      },
      pro: {
        label: 'DeepSeek-V4-Pro',
        off: { hit: 0.022 * RATE_FALLBACK, miss: 0.66 * RATE_FALLBACK, out: 1.98 * RATE_FALLBACK },
        peak: { hit: 0.044 * RATE_FALLBACK, miss: 1.32 * RATE_FALLBACK, out: 3.96 * RATE_FALLBACK }
      }
    };

    function CostChip(props) {
      var state = React.useState(null);
      var data = state[0];
      var setData = state[1];
      var clock = React.useState(bjNow());
      var bj = clock[0];
      var setBj = clock[1];

      React.useEffect(function () {
        var alive = true;
        var fails = 0;
        var stop = null;
        var startedAt = Date.now();

        function tick() {
          if (!alive) return;
          setBj(bjNow());
          host.call('snapshot', { sessionId: String(props.sessionId || '') })
            .then(function (next) {
              if (!alive) return;
              fails = 0;
              setData(next && typeof next === 'object' ? next : null);
            })
            .catch(function () {
              fails += 1;
              if (fails === 6) console.error('无法从 Host 获取费用账本（继续重试）');
            });
          // 前 30 秒每秒轮询，之后降到 5 秒
          stop = ctx.timeout(tick, Date.now() - startedAt < 30000 ? 1000 : 5000);
        }

        stop = ctx.timeout(tick, 0);
        return function () {
          alive = false;
          if (stop) stop();
        };
      }, [props.sessionId]);

      if (data === null || typeof data !== 'object') return null;
      var hasCost = data.ok === true;
      var bal = data.balance && typeof data.balance === 'object' && data.balance.ok === true ? data.balance : null;
      // 既无消费也无余额时不占位
      if (!hasCost && bal === null) return null;

      var table = data.table && data.table.flash ? data.table : FALLBACK_TABLE;
      var key = data.key === 'pro' ? 'pro' : 'flash';
      var prices = table[key] || table.flash;
      var tierKey = bj.peak ? 'peak' : 'off';
      var rows = [
        ['\u8F93\u5165 \u00B7 \u7F13\u5B58\u547D\u4E2D', prices.off.hit, prices.peak.hit],
        ['\u8F93\u5165 \u00B7 \u7F13\u5B58\u672A\u547D\u4E2D', prices.off.miss, prices.peak.miss],
        ['\u8F93\u51FA', prices.off.out, prices.peak.out]
      ];

      var stat = function (k, v, warn) {
        return React.createElement('div', { className: 'dsc-row', key: k },
          React.createElement('span', null, k),
          React.createElement('span', { className: warn ? 'dsc-warn' : '' }, v)
        );
      };

      var tipParts = [
        React.createElement('div', { className: 'dsc-hd', key: 'hd' },
          React.createElement('span', null, prices.label),
          React.createElement('span', null, (bj.peak ? '\u{1F534}\u9AD8\u5CF0' : '\u{1F7E2}\u7A7A\u95F2') + ' \u00B7 \u5317\u4EAC ' + bj.time)
        ),
        React.createElement('table', { key: 'tb' }, React.createElement('tbody', null,
          React.createElement('tr', null,
            React.createElement('th', null, '\u9879\u76EE\uFF08\u00A5/\u767E\u4E07 tokens\uFF09'),
            React.createElement('th', { className: tierKey === 'off' ? 'on' : '' }, '\u7A7A\u95F2'),
            React.createElement('th', { className: tierKey === 'peak' ? 'on' : '' }, '\u9AD8\u5CF0')
          ),
          rows.map(function (r, i) {
            return React.createElement('tr', { key: 'r' + i },
              React.createElement('td', null, r[0]),
              React.createElement('td', { className: tierKey === 'off' ? 'on' : '' }, r[1].toFixed(2)),
              React.createElement('td', { className: tierKey === 'peak' ? 'on' : '' }, r[2].toFixed(2))
            );
          })
        )),
        React.createElement('div', { className: 'dsc-sep', key: 'sp' })
      ];

      // 余额区块
      if (bal !== null) {
        tipParts.push(stat('\u8D26\u6237\u4F59\u989D', fmtCny(bal.total) + ' ' + (bal.currency || ''), bal.available === false));
        if (bal.topped > 0) tipParts.push(stat('\u5176\u4E2D\u5145\u503C', fmtCny(bal.topped)));
        if (bal.granted > 0) tipParts.push(stat('\u5176\u4E2D\u8D60\u9001', fmtCny(bal.granted)));
        if (bal.available === false) {
          tipParts.push(React.createElement('div', { className: 'dsc-note dsc-warn', key: 'bw' }, '\u8D26\u6237\u4F59\u989D\u4E0D\u8DB3\u6216\u4E0D\u53EF\u7528'));
        }
        tipParts.push(React.createElement('div', { className: 'dsc-sep', key: 'sp2' }));
      } else if (data.balanceError) {
        tipParts.push(React.createElement('div', { className: 'dsc-note dsc-warn', key: 'be' }, '\u4F59\u989D\u8BFB\u53D6\u5931\u8D25\uFF1A' + String(data.balanceError)));
        tipParts.push(React.createElement('div', { className: 'dsc-sep', key: 'sp3' }));
      }

      // 消费区块
      if (hasCost) {
        tipParts.push(stat('\u672C\u4F1A\u8BDD\u8D39\u7528', fmtCny(data.cost)));
        tipParts.push(stat('\u7F13\u5B58\u547D\u4E2D', fmtTokens(data.hit)));
        tipParts.push(stat('\u7F13\u5B58\u672A\u547D\u4E2D', fmtTokens(data.miss)));
        tipParts.push(stat('\u8F93\u51FA', fmtTokens(data.out)));
        tipParts.push(stat('\u8C03\u7528\u6B21\u6570', String(data.calls || 0)));
        tipParts.push(stat('\u65F6\u6BB5\u5206\u5E03', '\u9AD8\u5CF0 ' + fmtCny(data.peakCost) + ' \u00B7 \u7A7A\u95F2 ' + fmtCny(data.offCost)));
      }

      tipParts.push(React.createElement('div', { className: 'dsc-note', key: 'nt' },
        '\u6309\u6BCF\u6B21\u8C03\u7528\u53D1\u8D77\u65F6\u523B\u7684\u5355\u4EF7\u9010\u6B21\u8BA1\u4EF7\u540E\u7D2F\u52A0\u3002' +
        '\u9AD8\u5CF0\uFF1A\u5317\u4EAC\u65F6\u95F4\u5468\u4E00~\u5468\u4E94 09:00-12:00\u300114:00-18:00\uFF0C\u5176\u4F59\uFF08\u542B\u5468\u672B\u5168\u5929\uFF09\u7A7A\u95F2\u3002' +
        '\u6309 1 USD = ' + (data.rate || RATE_FALLBACK) + ' CNY \u6298\u7B97\uFF0C\u4EC5\u4F9B\u53C2\u8003\u3002'
      ));

      // 胶囊：峰谷点 + 本会话费用 + 余额
      var chipParts = [React.createElement('span', { className: 'dsc-dot ' + tierKey, key: 'dt' })];
      if (hasCost) {
        chipParts.push(React.createElement('span', { className: 'dsc-amt', key: 'amt' }, fmtCny(data.cost)));
      }
      if (bal !== null) {
        if (hasCost) chipParts.push(React.createElement('span', { className: 'dsc-div', key: 'dv' }));
        chipParts.push(React.createElement('span', { className: 'dsc-bal', key: 'bal' }, '\u4F59\u989D ' + fmtCny(bal.total)));
      }

      return React.createElement('div', { className: 'dsc-root' },
        React.createElement('span', { className: 'dsc-chip' }, chipParts),
        React.createElement('div', { className: 'dsc-tip' }, tipParts)
      );
    }

    slots.inject('conversation.input.right', function () {
      return slots.register(
        { name: 'conversation.input.right', id: 'dscost' },
        CostChip
      );
    });
  }
};
