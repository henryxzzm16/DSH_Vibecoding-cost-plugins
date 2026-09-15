/* dsh-deepseek-cost — 纯计算核心（无 Cordis / DOM / 网络依赖，可独立测试）
 *
 * 价格来源：DeepSeek 官方定价页 https://api-docs.deepseek.com/quick_start/pricing
 *   官方以 USD / 百万 tokens 计价，高峰价为空闲价的 2 倍：
 *     flash : 命中 0.003 / 0.006 ，未命中 0.15 / 0.30 ，输出 0.60 / 1.20
 *     v4-pro: 命中 0.022 / 0.044 ，未命中 0.66 / 1.32 ，输出 1.98 / 3.96
 *   峰谷时段（官方 UTC 周一~周五 01:00-04:00、06:00-10:00）
 *   换算成北京时间即 09:00-12:00、14:00-18:00，其余（含周末全天）为空闲。
 *   人民币数值 = USD × RATE，仅作展示，改 RATE 即可。
 */

// 展示用汇率（1 USD = ? CNY）
var RATE = 6.77;

// USD/百万tokens；cny 由 RATE 派生，保证同源不漂移
function tier(hit, miss, out) {
  return { hit: hit, miss: miss, out: out, cny: { hit: hit * RATE, miss: miss * RATE, out: out * RATE } };
}

var PRICING = {
  flash: { label: 'DeepSeek-V4.1-Flash', match: /flash/i, off: tier(0.003, 0.15, 0.60), peak: tier(0.006, 0.30, 1.20) },
  pro: { label: 'DeepSeek-V4-Pro', match: /pro/i, off: tier(0.022, 0.66, 1.98), peak: tier(0.044, 1.32, 3.96) }
};

// 仅 DeepSeek 模型计价（模型名含 deepseek）
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

// TokenUsage -> 计费明细。适配器把 inputTokens 映射为「非缓存命中」的输入，
// 故未命中以 inputTokens 为准；只有它缺失时才用 cacheWriteTokens 兜底，避免重复计费。
function buckets(u) {
  var input = num(u.inputTokens);
  var hit = num(u.cacheReadTokens);
  var write = num(u.cacheWriteTokens);
  var out = num(u.outputTokens);
  var miss = input > 0 ? input : write;
  return { hit: hit, miss: miss, out: out, total: miss + hit + out };
}

// 取某时段的人民币单价（元/百万 tokens）
function priceOf(key, peak) {
  return (PRICING[key] || PRICING.flash)[peak ? 'peak' : 'off'].cny;
}

// 单次调用费用（元）
function costOf(usage, key, peak) {
  var t = priceOf(key, peak);
  var b = buckets(usage);
  return (b.hit * t.hit + b.miss * t.miss + b.out * t.out) / 1e6;
}

// 高峰+空闲两档价格表，供 UI 展示
function priceTable() {
  return {
    flash: { label: PRICING.flash.label, off: PRICING.flash.off.cny, peak: PRICING.flash.peak.cny },
    pro: { label: PRICING.pro.label, off: PRICING.pro.off.cny, peak: PRICING.pro.peak.cny }
  };
}

/* ===== DeepSeek 余额接口 https://api.deepseek.com/user/balance =====
 * 返回形如：
 *   { is_available: true, balance_infos: [ { currency: "CNY", total_balance: "12.34",
 *     granted_balance: "0.00", topped_up_balance: "12.34" } ] }
 * 鉴权失败时返回 { error: { message: "Authentication Fails, ..." } }。
 * 这里把字符串转成数字；多币种时优先取 CNY，否则取第一项。
 */

// curl config 里的字面量：值可能含反斜杠/引号，必须转义后再包一层双引号。
// 注意 curl 8.3+ 默认关闭 config 内的 $VAR 展开，所以 Authorization 头必须写字面值。
function curlQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

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

function fmtCny(v) {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return '\u00A50.0000';
  if (v < 0.01) return '\u00A5' + v.toFixed(4);
  if (v < 1) return '\u00A5' + v.toFixed(3);
  return '\u00A5' + v.toFixed(2);
}

function fmtTokens(n) {
  n = num(n);
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '\u4EBF';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '\u4E07';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
