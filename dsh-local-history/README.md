# DeepSeek 旧聊天导入

把 DeepSeek 导出的旧问答写入 DSH Go 的普通会话。打开导入的聊天，往上滑能看到旧问答，在底部可以继续聊。

## 在安卓手机上使用

需要 DSH Go 1.1.0 或兼容版本，以及本机引擎 DSH `>=0.2.2-rc.1 <0.2.3-0`。插件按 Android 本机引擎的文件位置开发。

1. 上架后，在 DSH Go 打开「设置 → 插件 → 插件市场」，切到「适配 DSH Go」，搜索 **DeepSeek 旧聊天导入** 或 **dsh-local-history**，安装到「本机」。按 App 的提示启用或重启引擎。
2. 用手机从原 DeepSeek 导出历史对话，将原始 `deepseek_data…zip` 或 `deepseek-data…zip` 放在手机「下载」里，保留 ZIP。
3. 在 DSH Go 的「设置 → 权限」开启「访问手机文件」。回到聊天界面，点输入框左边的「＋ → 导入旧聊天 → 扫描手机下载」，选择 ZIP 和聊天标题。如果弹出工作区选择，选一个工作区或点「创建导入工作区」。
4. 回到会话列表，打开导入的聊天标题，往上滑检查旧问答。要发新消息，先在 DSH Go 配好模型，再从该会话底部继续聊。

插件在手机上读取 ZIP，并把选定的会话写入 DSH Go 本机会话。导入操作没有网络请求。之后发送新消息时，提供给模型的上下文遵循 DSH Go 和你所选模型服务的配置。

每次导入一条对话。插件保留导出中当前分支的原问答及有效时间，附件保留文件名。其他分支和附件内容可留在原始备份中。重复导入同一工作区的同一会话分支时，可以从会话列表打开已有记录。

应用下载请使用 [DSH Go 官网](https://go.dshtui.com/download)或 [DSH Go GitHub Releases](https://github.com/ccch1mneyyy/dsh-go/releases)。

## Development

This independent plugin imports a DeepSeek export ZIP as a regular conversation in the Android local DSH Go engine. It scans the phone’s Downloads folder on request and writes the selected conversation to a local workspace. Import does not call a network service. The package contains the plugin source and uses the installed engine’s session module. Its native panel is in Simplified Chinese.

Use Node.js 24.9 or later. Run `npm test` for the synthetic archive and session tests and `npm pack --dry-run --ignore-scripts` to check the files npm will ship. The tests use a local test double for the engine. Test installation and import on an Android device before submitting the package to the market.

Related projects: [DSH Go](https://github.com/ccch1mneyyy/dsh-go) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This plugin's source is available under the [MIT License](LICENSE).
