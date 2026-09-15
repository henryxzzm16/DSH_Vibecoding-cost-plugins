/* 纯核心自检：node core.test.cjs */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const core = new Function(src +
  '\nreturn {RATE,PRICING,isPeak,buckets,costOf,modelKey,fmtCny,fmtTokens,bjParts,priceOf,parseBalance,curlQuote};')();

let fails = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('ok   ' + name);
  else { fails++; console.log('FAIL ' + name + (extra === undefined ? '' : '  -> ' + extra)); }
};
const at = (iso) => Date.parse(iso);
const CNY = core.RATE;

console.log('--- 峰谷判定（北京时间，UTC 构造）---');
ok('周一 09:00 = 高峰（下界）', core.isPeak(at('2026-02-02T01:00:00Z')) === true);
ok('周一 08:59 = 空闲', core.isPeak(at('2026-02-02T00:59:00Z')) === false);
ok('周一 12:00 = 空闲（右开）', core.isPeak(at('2026-02-02T04:00:00Z')) === false);
ok('周一 14:00 = 高峰', core.isPeak(at('2026-02-02T06:00:00Z')) === true);
ok('周一 17:59 = 高峰', core.isPeak(at('2026-02-02T09:59:00Z')) === true);
ok('周一 18:00 = 空闲（右开）', core.isPeak(at('2026-02-02T10:00:00Z')) === false);
ok('周六 10:00 = 空闲（周末）', core.isPeak(at('2026-02-07T02:00:00Z')) === false);
ok('周日 15:00 = 空闲（周末）', core.isPeak(at('2026-02-08T07:00:00Z')) === false);
ok('bjParts 时区无关（北京 10:00）', core.bjParts(at('2026-02-02T02:00:00Z')).text === '10:00');

console.log('--- 模型识别（仅 deepseek）---');
ok('deepseek-flash -> flash', core.modelKey('deepseek-flash') === 'flash');
ok('deepseek-v4-pro -> pro', core.modelKey('deepseek-v4-pro') === 'pro');
ok('DeepSeek-V4.1-Flash -> flash', core.modelKey('DeepSeek-V4.1-Flash') === 'flash');
ok('deepseek 无档位 -> flash', core.modelKey('deepseek-chat') === 'flash');
ok('gpt-4o 不计价', core.modelKey('gpt-4o') === null);
ok('claude-3.5-sonnet 不计价', core.modelKey('claude-3.5-sonnet') === null);
ok('gemini-pro 不计价（含 pro 也不算）', core.modelKey('gemini-pro') === null);
ok('空串不计价', core.modelKey('') === null);

console.log('--- usage 桶映射 ---');
const b1 = core.buckets({ inputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 300 });
ok('输入拆分 hit/miss', b1.hit === 800 && b1.miss === 200 && b1.out === 300, JSON.stringify(b1));
ok('total 汇总', b1.total === 1300, String(b1.total));
const b2 = core.buckets({ inputTokens: 500, outputTokens: 100 });
ok('无缓存字段 -> 全按未命中', b2.hit === 0 && b2.miss === 500 && b2.out === 100, JSON.stringify(b2));
const b3 = core.buckets({ cacheWriteTokens: 900, outputTokens: 50 });
ok('纯建缓存（无 inputTokens）：miss 用 write 兜底', b3.miss === 900, JSON.stringify(b3));
const b3b = core.buckets({ inputTokens: 100, cacheWriteTokens: 900, outputTokens: 50 });
ok('inputTokens 优先，不与 write 重复计费', b3b.miss === 100 && b3b.total === 150, JSON.stringify(b3b));
ok('负数/脏值归零', core.buckets({ inputTokens: -5, cacheReadTokens: NaN, outputTokens: '9' }).total === 0);

console.log('--- 计价（官方 USD 价 x RATE = 元）---');
const u = (hit, miss, out) => ({ inputTokens: miss, cacheReadTokens: hit, outputTokens: out });
ok('flash 空闲 1M 命中 = $0.003', Math.abs(core.costOf(u(1e6, 0, 0), 'flash', false) - 0.003 * CNY) < 1e-9);
ok('flash 高峰 1M 命中 = $0.006', Math.abs(core.costOf(u(1e6, 0, 0), 'flash', true) - 0.006 * CNY) < 1e-9);
ok('flash 空闲 1M 未命中 = $0.15', Math.abs(core.costOf(u(0, 1e6, 0), 'flash', false) - 0.15 * CNY) < 1e-9);
ok('flash 高峰 1M 输出 = $1.20', Math.abs(core.costOf(u(0, 0, 1e6), 'flash', true) - 1.20 * CNY) < 1e-9);
ok('pro 空闲 1M 命中 = $0.022', Math.abs(core.costOf(u(1e6, 0, 0), 'pro', false) - 0.022 * CNY) < 1e-9);
ok('pro 高峰 1M未命中+1M输出 = $5.28', Math.abs(core.costOf(u(0, 1e6, 1e6), 'pro', true) - (1.32 + 3.96) * CNY) < 1e-9);
ok('高峰恰为空闲 2 倍', Math.abs(core.costOf(u(123, 456, 789), 'pro', true) - 2 * core.costOf(u(123, 456, 789), 'pro', false)) < 1e-12);
ok('缓存创建（inputTokens 缺失时）按未命中价', Math.abs(core.costOf({ cacheWriteTokens: 1e6, outputTokens: 0 }, 'flash', false) - 0.15 * CNY) < 1e-9);
ok('priceOf 返回元单价', core.priceOf('flash', true).hit === 0.006 * CNY);

console.log('--- 金额格式化 ---');
ok('0 -> 0.0000', core.fmtCny(0) === '\u00A50.0000');
ok('小额 4 位', core.fmtCny(0.001234) === '\u00A50.0012', core.fmtCny(0.001234));
ok('中额 3 位', core.fmtCny(0.5678) === '\u00A50.568', core.fmtCny(0.5678));
ok('大额 2 位', core.fmtCny(12.345) === '\u00A512.35', core.fmtCny(12.345));
ok('fmtTokens 万', core.fmtTokens(16800000) === '1680.00\u4E07', core.fmtTokens(16800000));
ok('fmtTokens K', core.fmtTokens(1200) === '1.2K', core.fmtTokens(1200));

console.log('--- 真实场景：45K 输入(90%命中) + 2K 输出，高峰 flash ---');
const real = core.costOf({ inputTokens: 4500, cacheReadTokens: 40500, outputTokens: 2000 }, 'flash', true);
ok('费用落在合理区间 (0.02~0.04 元)', real > 0.02 && real < 0.04, core.fmtCny(real));

console.log('--- curl config 字面量转义 ---');
ok('普通串包引号', core.curlQuote('sk-abc123') === '"sk-abc123"', core.curlQuote('sk-abc123'));
ok('双引号被转义', core.curlQuote('a"b') === '"a\\"b"', core.curlQuote('a"b'));
ok('反斜杠被转义', core.curlQuote('a\\b') === '"a\\\\b"', core.curlQuote('a\\b'));

console.log('--- 余额接口解析 ---');
const bal = core.parseBalance({
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }]
});
ok('CNY 余额解析', bal && bal.total === 12.34 && bal.currency === 'CNY' && bal.available === true, JSON.stringify(bal));
ok('赠送/充值拆分', bal && bal.granted === 2 && bal.topped === 10.34);
const balUsd = core.parseBalance({
  is_available: true,
  balance_infos: [{ currency: 'USD', total_balance: '1.50', granted_balance: '0', topped_up_balance: '1.50' }]
});
ok('无 CNY 时取第一项', balUsd && balUsd.total === 1.5 && balUsd.currency === 'USD');
const balMixed = core.parseBalance({
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1' },
    { currency: 'CNY', total_balance: '9.99', granted_balance: '0', topped_up_balance: '9.99' }
  ]
});
ok('多币种优先 CNY', balMixed && balMixed.total === 9.99, JSON.stringify(balMixed));
ok('is_available=false 传递', core.parseBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0' }] }).available === false);
ok('空 balance_infos -> null', core.parseBalance({ balance_infos: [] }) === null);
ok('缺字段 -> null', core.parseBalance({}) === null);
ok('非对象 -> null', core.parseBalance(null) === null && core.parseBalance('x') === null);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
