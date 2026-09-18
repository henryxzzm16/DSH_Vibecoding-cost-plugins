# dsh-deepseek-cost

DSH 插件：对话输入区显示**本会话 DeepSeek API 费用**与**账户余额**，按真实模型与北京峰谷分时计价。全部由 AI 搭建，纯 JavaScript、无构建步骤。

```
● ¥0.0034 │ 余额 ¥12.34
```

绿点 = 空闲，红点 = 高峰；悬停展开完整价格表、tokens 明细与峰谷分布。配色走 DSH 主题变量，跟随「设置 → 外观」。

**静态 bundle 插件**：跟着 DSH 一起启动，重启后依然在，无审批流程。

## 价格

来源 <https://api-docs.deepseek.com/quick_start/pricing>（USD / 百万 tokens，高峰 = 空闲 × 2）

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- |
| V4.1-Flash | 0.003 / 0.006 | 0.15 / 0.30 | 0.60 / 1.20 |
| V4-Pro | 0.022 / 0.044 | 0.66 / 1.32 | 1.98 / 3.96 |

- 每格为 `空闲 / 高峰`；高峰 = 北京时间周一~周五 `09:00-12:00`、`14:00-18:00`，其余（含周末）空闲。
- 展示按 `1 USD = 6.77 CNY` 折算（`rate` 可配），仅供参考。

## 原理

- **Host**（`lib/index.js`）折叠会话日志：`request/header` 决定当时用的模型，`assistant/message` 带 `usage`，按调用发生时刻的北京时段逐次计价累加 —— 中途 flash 换 pro 会按各自单价分别计费。
- **Client**（`lib/client.js`）注册 `conversation.input.right` 胶囊，轮询 `/api/dsh-deepseek-cost/snapshot`。
- 余额经 `ctx.subprocess` 调 `curl` 请求 `GET /user/balance`，API key 从 `credentials` 解析后经 stdin 传入（不进 argv、不落盘）；成功缓存 60s，失败退避 10s。

## 安装

```powershell
dsh plugin --profile web add link:D:\桌面\DSH\dsh-deepseek-cost
```

装完**重启 DSH** 生效。手工装法：`package.json` 的 `dsh.profile.bundles` 追加 `dsh-deepseek-cost`，并在 `profiles\web\node_modules\` 放一个指向本包的 junction。

## 配置

在 profile 的 `cordis.patch.yml` 里按 row id 覆盖：

```yaml
- id: dsh-deepseek-cost
  config:
    rate: 7.1
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `rate` | `6.77` | 1 USD 折合人民币，仅用于展示 |
| `balanceOkMs` | `60000` | 余额成功缓存时长 |
| `balanceErrMs` | `10000` | 余额失败重试间隔 |
| `snapshotPath` | `/api/dsh-deepseek-cost/snapshot` | 快照路由，必须位于 `/api` 下 |

## 自检

```bash
node --check lib/client.js   # 浏览器半边语法
node core.test.cjs           # 计价/峰谷/折叠 单测（零依赖）
node verify-mount.cjs        # 假 ctx 调 apply()，验证投影与路由（需已装依赖）
```

- `core.test.cjs` 只 import `lib/core.js`（**零依赖**的纯函数：模型判定、价格表、
  峰谷时段、token 桶归一、账本折叠），因此**不需要安装任何依赖就能跑**，CI 里直接跑。
  如果让单测去 import `lib/index.js`，会连带加载 `@deepseek-ai/schemastery` 与 `zod`，
  在只做 checkout 的 CI 环境里会 `ERR_MODULE_NOT_FOUND`。
- `verify-mount.cjs` 需要真实依赖（schema 契约必须用真的 zod 验证），因此只在本地跑。

投影契约要求 `stateSchema` 与 `wire.viewSchema`（zod）都存在 —— 缺失会让**所有会话**的断点恢复报 `reading 'parse'`；注册前有一道护栏，schema 不可用就整体跳过投影。改动折叠语义时必须递增 `stateVersion`。

## 已知边界

- 金额是按官方单价复算的**估算**，不等于官方账单。
- 只给模型名含 `deepseek` 的调用计价；余额是**账户级**的。
- 账本在 Host 进程内存里按 sessionId 累积，重启后只从新会话重建（最多 200 个会话）；子代理 / 旁路调用带自己的 session id，不计入本会话。

## 免责声明

**个人自用工具，全 AI 搭建。** 这个插件是作者自己看会话花费用的，不是给别人用的产品：
**不提供技术支持，不承诺维护，不保证适配你的 DSH 版本。**
作者是新手，代码由 AI 生成并在本机反复调试，没有经过专业评审 ——
**遇到问题建议找专业人士，或把完整报错贴给 AI 帮你调试。**

**关于数字，请务必注意：**

- 金额是**估算**：按官方公开单价 × 日志里的 token 用量复算，再用固定汇率 `rate`
  （默认 6.77）折算展示。**它不等于官方账单**，请以官方为准；**不构成任何财务建议**。
- **余额是账户级的**，不是本会话的；请求失败会退避重试，期间可能显示旧值或错误态。
- 计价只覆盖**模型名含 `deepseek`** 的调用，其他模型不计入。

**未验证范围**：只在作者本人环境（Windows + DSH web + 单一 DeepSeek 账号）实际使用过。
其他 DSH 版本、其他操作系统、其他账号、多人共用等场景**都没有试过**。
其余已知边界见上文「已知边界」一节。

**风险自负**：本软件按 MIT 许可证「**原样**」提供，**不附带任何形式的担保**。
因使用本插件造成的任何损失（包括但不限于对费用的误判、误以为余额充足等）
**由使用者自行承担**。

## License

MIT
