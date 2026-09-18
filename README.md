# DSH_Vibecoding-cost-plugins

给 **DSH（DeepSeek Harness）** 写的插件集合。**全部由 AI 搭建**，纯 JavaScript、无构建步骤。

## 插件

| 插件 | 版本 | 说明 |
|---|---|---|
| [`dsh-deepseek-cost`](plugins/deepseek/dsh-deepseek-cost/) | v2.0.0 | 对话输入区显示本会话 DeepSeek API 费用（按真实模型 + 北京峰谷分时计价）+ 账户余额 |

## 下载

[Releases](https://github.com/henryxzzm16/DSH_Vibecoding-cost-plugins/releases) 里的
`dsh-deepseek-cost-v2.0.0.zip`（8 个文件），解压后把目录链接进 profile 即可。

| 版本 | manifestSha256 |
|---|---|
| v2.0.0 | `efbbcd5343db64a1f76a1e89d16e48937c23f42c15f5535516fb7dfdb4b7fca2` |

校验用 `manifestSha256`，不用 zip 自身哈希 —— zip 头带时间戳，换打包器或换个时刻字节就会变。
它是「相对路径 + 字节数 + 文件 sha256」排序后算出来的，同一份源码恒定。

## 安装

插件是 **DSH 静态 bundle 插件**：跟着 DSH 一起启动，**重启后依然在**，无审批流程。

```powershell
dsh plugin --profile web add link:C:\path\to\dsh-deepseek-cost
```

改完重启 DSH（profile 的 bundle 栈只在启动时组装一次）。装好后输入区右侧出现费用胶囊，悬停展开价格表与余额。

## 自检

```bash
node --check lib/client.js   # 浏览器半边语法
node core.test.cjs           # 计价/峰谷/折叠 单测
node verify-mount.cjs        # 假 ctx 调 apply()，验证投影与路由
```

## 免责声明

**个人自用工具，全 AI 搭建。** 这些插件是作者自己看会话花费用的，不是产品：
不保证适配你的 DSH 版本、不保证后续维护、**不提供技术支持**。
作者是新手，代码由 AI 生成并在本机反复调试，没有经过专业评审 ——
**有问题建议找专业人士，或让 AI 帮你调试。**

⚠️ **金额是估算，不是账单。** 按官方单价与 token 用量复算，并按固定汇率 `rate`
（默认 6.77）折算展示，**可能与官方实际扣费不一致，请以官方账单为准**；
**不构成任何财务建议**。

**未验证范围**：只在作者本人环境（Windows + DSH web + 单一 DeepSeek 账号）用过。
其他 DSH 版本、其他操作系统、其他账号**都没试过**。
各插件自身的已知边界见对应插件的 README。

本仓库以 MIT 许可证「**原样**」提供，**不附带任何担保**，使用风险自负。

## License

MIT
