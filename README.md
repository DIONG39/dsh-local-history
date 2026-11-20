# DeepSeek 旧聊天导入

把 DeepSeek 导出的旧问答写入 DSH Go 的普通会话。打开导入的聊天，往上滑能看到旧问答，在底部可以继续聊。

## 在安卓手机上使用

需要 DSH Go 1.1.0 或兼容版本，以及本机引擎 DSH `>=0.2.2-rc.1 <0.2.3-0`。插件按 Android 本机引擎的文件位置开发。

1. 上架后，在 DSH Go 打开「设置 → 插件 → 插件市场」，切到「适配 DSH Go」，搜索 **DeepSeek 旧聊天导入** 或 **dsh-local-history**，安装到「本机」。按 App 的提示启用或重启引擎。
2. 用手机从原 DeepSeek 导出历史对话，下载 ZIP，保留压缩包。
3. 在 DSH Go 聊天界面点输入框左边的「＋ → 导入旧聊天 → 选择 ZIP 文件」，在手机的文件窗口点刚下载的 ZIP。聊天列表出现后，点标题可导入一段，点「一键导入全部」可导入这个 ZIP 里的所有对话。如果弹出工作区选择，选一个工作区或点「创建导入工作区」。
4. 回到会话列表，打开导入的聊天标题，往上滑检查旧问答。要发新消息，先在 DSH Go 配好模型，再从该会话底部继续聊。

「选择 ZIP 文件」支持单个最大 8 MiB 的 ZIP。需要处理更大的 ZIP，或者页面只显示「扫描手机下载」时，把 ZIP 保存到手机「下载」，在 DSH Go 的「设置 → 权限」开启「访问手机文件」，再点「扫描手机下载」。扫描会尝试识别浏览器改过名字的 ZIP。

使用本机引擎时，插件在手机上读取 ZIP，并把选定的会话写入 DSH Go 本机会话。之后发送新消息时，提供给模型的上下文遵循 DSH Go 和你所选模型服务的配置。

每段导入的对话会成为一条独立会话。批量导入结束后会显示成功、已导入过和失败的数量。点「停止导入」会保留已经完成的会话，下次可以继续导入，完整保存的对话会自动跳过。若写入曾中断，再次导入时会核对已保存的消息，再补写缺失的部分。

插件保留导出中当前分支的原问答及有效时间，附件保留文件名。其他分支和附件内容可留在原始备份中。

应用下载请使用 [DSH Go 官网](https://go.dshtui.com/download)或 [DSH Go GitHub Releases](https://github.com/ccch1mneyyy/dsh-go/releases)。

## Development

This independent plugin imports a DeepSeek export ZIP as a regular conversation in the Android local DSH Go engine. It supports the native file picker and scanning the phone’s Downloads folder. The package contains the plugin source and uses the installed engine’s session module. Its native panel is in Simplified Chinese.

Use Node.js 24.9 or later. Run `npm test` for the synthetic archive and session tests and `npm pack --dry-run --ignore-scripts` to check the files npm will ship. The tests use a local test double for the engine. Test installation and import on an Android device before submitting the package to the market.

Related projects: [DSH Go](https://github.com/ccch1mneyyy/dsh-go) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This plugin's source is available under the [MIT License](LICENSE).
