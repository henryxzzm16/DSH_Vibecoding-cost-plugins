# DSH_Vibecoding-plugins

给 **DSH（DeepSeek Harness）** 写的插件集合。**全部由 AI 搭建**，纯 JavaScript、无构建步骤。

## 插件

| 插件 | 版本 | 说明 |
|---|---|---|
| [`dsh-deepseek-cost`](plugins/deepseek/dsh-deepseek-cost/) | v2.0.0 | 对话输入区显示本会话 DeepSeek API 费用（按真实模型 + 北京峰谷分时计价）+ 账户余额 |

## 下载

[Releases](https://github.com/henryxzzm16/DSH_Vibecoding-plugins/releases) 里的
`dsh-deepseek-cost-v2.0.0.zip`（8 个文件），解压后把目录链接进 profile 即可。

| 版本 | manifestSha256 |
|---|---|
| v2.0.0 | `efbbcd5343db64a1f76a1e89d16e48937c23f42c15f5535516fb7dfdb4b7fca2` |

校验用 `manifestSha256`，不用 zip 自身哈希 —— zip 头带时间戳，换打包器或换个时刻字节就会变。
它是「相对路径 + 字节数 + 文件 sha256」排序后算出来的，同一份源码恒定。

> 本仓库为**私有**仓库，Release 附件下载需要登录 GitHub 账号。

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

## License

MIT
