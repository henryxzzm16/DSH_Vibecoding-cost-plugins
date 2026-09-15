# dsh-deepseek-cost

DSH（DeepSeek Harness）插件：在对话输入区**实时显示当前会话的 DeepSeek API 费用**，按北京时间**高峰/空闲分时计价**，同时显示**账户余额**。

```
● ¥0.0034 │ 余额 ¥12.34      ← 鼠标悬停展开完整价格表
```

- 绿点 = 空闲时段，红点 = 高峰时段，**每秒**刷新
- 悬停显示：当前模型两档价格表、缓存命中/未命中/输出 tokens、调用次数、峰谷消费分布、账户余额（含充值/赠送拆分）
- 配色全部走 DSH 主题变量，跟随「设置 → 外观」自动适配浅色/深色

## 功能

| 需求 | 实现 |
|---|---|
| 费用计算 | 监听 `llm/stream` waterfall，读取每个 `usage` chunk（真实用量，非估算） |
| 缓存命中 | `usage.cacheReadTokens` |
| 缓存未命中 | `usage.inputTokens`（DSH 适配器已映射为 `prompt_tokens - cache_read`） |
| 输出 | `usage.outputTokens` |
| 模型过滤 | 仅模型名含 `deepseek` 时计价，其他厂商不计算 |
| 分时定价 | 按**每次调用发起时刻**的北京时间取单价，逐次累加 |
| 累计 | 当前会话总费用 |
| 余额 | 官方 `GET /user/balance`，60 秒缓存 |

## 安装

本插件是 **DSH 动态 Cordis 插件**（进程内、纯 JavaScript，不需要构建）。

1. 取 `plugin.js` 全文，按文件内 `HOST 半边` / `CLIENT 半边` 两个分界标记切开；
2. 两段分别作为 `cordis_define` 的 `code.host` 与 `code.client` 提交；
3. 用返回的 `pluginId` / `packageId` 调 `cordis_run` 激活（Client 半边需要你在界面上批准）。

> 动态包**不跨进程序列化**：重启 DSH 后需要重新 define + run，且费用账本从零开始累计。

## 定价

价格取自 DeepSeek 官方定价页 <https://api-docs.deepseek.com/quick_start/pricing>（USD / 百万 tokens）：

| 模型 | 项目 | 空闲 | 高峰 |
|---|---|---|---|
| `deepseek-flash`（V4.1-Flash） | 输入·缓存命中 | $0.003 | $0.006 |
| | 输入·缓存未命中 | $0.15 | $0.30 |
| | 输出 | $0.60 | $1.20 |
| `deepseek-v4-pro`（V4-Pro） | 输入·缓存命中 | $0.022 | $0.044 |
| | 输入·缓存未命中 | $0.66 | $1.32 |
| | 输出 | $1.98 | $3.96 |

- 高峰 = 空闲 × 2；峰时段官方写作 UTC 周一~周五 `01:00-04:00`、`06:00-10:00`，换算成北京时间即 **`09:00-12:00`、`14:00-18:00`**，其余（含周末全天）为空闲。
- 费用 = (命中×命中单价 + 未命中×未命中单价 + 输出×输出单价) ÷ 1,000,000

**关于人民币**：官方只公布 USD 价格，插件按 `RATE`（默认 `1 USD = 6.77 CNY`）折算展示，悬停面板中写明了汇率。改 `plugin.js` 顶部的 `RATE` 一个常量即可调整。

## 技术说明：动态包沙箱的三个限制

写这个插件时踩到的坑，对写其他 DSH 动态插件同样适用：

1. **全局 `fetch` 被禁用**。沙箱把它换成抛错陷阱，错误信息会指向 cordis `web` 服务。
2. **`ctx.web.fetch(request)` 只接受 URL，不转发自定义请求头**（它是公开网络抓取器，只发 `user-agent`/`accept`），所以需要 `Authorization` 的接口走不通这条路。
3. **`ctx.shell` 会给命令套上会话的 sandbox 模式**，本机没有对应 sandbox 后端时会直接拒绝执行。

因此余额请求走 **`ctx.subprocess.spawn`**：它只接受一份完全指定的 spawn 清单（`argv`/`cwd`/`stdio`/`graceMs`），**不做任何默认套用**，会话沙箱策略不参与。另外两个细节：

- **curl 8.3+ 默认关闭 config 文件里的 `$VAR` 展开**，`header = "Authorization: Bearer $DEEPSEEK_API_KEY"` 会把变量名当密钥发出去；必须写字面值（本插件把密钥经 **stdin** 送给子进程，不进 `argv`、不落盘）。
- 业务错误（如鉴权失败）可能带非 0 退出码返回，因此**先读响应体再判断退出码**，否则只会报出无用的「响应解析失败」。

## 开发

```bash
node core.test.cjs     # 计价核心自检（51 条断言）
node check-plugin.cjs  # 语法门禁：确认 plugin.js 两半都能被 DSH 求值
```

`core.js` 是与插件同源的纯计算核心（无 Cordis / DOM / 网络依赖），便于独立测试。

## 已知限制

- 子代理/侧调用携带各自的 session id，其费用计入**各自会话**的显示，不并入当前会话总额。
- 余额是**账户总额**，不是「本会话剩余」；它不会随本会话消费即时扣减，而是 60 秒后重新拉取。
- 金额为估算值，实际扣费以官方账单为准。

## License

MIT
