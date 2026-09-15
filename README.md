# DSH_Vibecoding-plugins

给 **DSH（DeepSeek Harness）** 写的插件集合。

## 目录结构

```
plugins/
└── deepseek/
    └── dsh-deepseek-cost/    ← 会话费用 + 余额
```

按厂商分类：`plugins/<厂商名>/<插件名>/`。

## 插件列表

| 插件 | 说明 |
|---|---|
| [`dsh-deepseek-cost`](plugins/deepseek/dsh-deepseek-cost/) | 对话输入区实时显示 DeepSeek API 会话费用（峰谷分时计价）+ 账户余额 |

## 关于 DSH 动态插件

本仓库的插件都是 **DSH 动态 Cordis 插件**：进程内运行、纯 JavaScript，不需要构建步骤（没有 TypeScript/JSX 转换，也没有打包器）。

安装方式：取插件目录下 `plugin.js` 的全文，按文件内 `HOST 半边` / `CLIENT 半边` 两个标记切开，分别作为 `cordis_define` 的 `code.host` 与 `code.client` 提交，再用返回的 `pluginId` / `packageId` 调 `cordis_run`。

> ⚠️ 动态包不跨进程序列化：重启 DSH 后需要重新 define + run，插件内部的内存状态（如费用账本）会从零开始。

## License

MIT
