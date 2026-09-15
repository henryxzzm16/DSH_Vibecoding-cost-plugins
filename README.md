# DSH_Vibecoding-plugins

给 **DSH（DeepSeek Harness）** 写的插件集合。**全部由 AI 搭建**，纯 JavaScript、无构建步骤。

## 插件

| 插件 | 版本 | 说明 |
|---|---|---|
| [`dsh-deepseek-cost`](plugins/deepseek/dsh-deepseek-cost/) | v2.0.0 | 对话输入区显示本会话 DeepSeek API 费用（按真实模型 + 北京峰谷分时计价）+ 账户余额 |

## 安装

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
