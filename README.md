# 轻匣

轻匣是一个 Windows 桌面工具箱，可以导入和管理本地插件。本仓库包含轻匣主程序、插件开发规范和示例插件。

## 下载

在 [Releases](https://github.com/lavieheureuse/qingxia/releases) 下载轻匣安装版或免安装版。源码位于 `toolbox/`。

官方安装包由 GitHub Actions 自动构建并附带 `SHA256SUMS.txt` 校验文件。在开源代码签名尚未正式启用前，Windows SmartScreen 可能弹出“Windows 已保护你的电脑”提示，确认来源为官方 Releases 并核对校验值后点击“更多信息”→“仍要运行”即可。

## 使用说明

1. 下载并运行安装版，或直接运行免安装版。
2. 打开轻匣，点击“添加工具”，选择插件目录中的 `plugin.json`，或直接通过 GitHub 仓库导入。轻匣会在选定的「插件目录」下保存插件副本，并在同目录下的 `plugin-data/` 统一保存各插件的配置、状态与已下载内核；重新导入更新插件时自动保留原有配置与内核，移除插件时可选择是否一并删除对应数据。
3. 在工具列表点击“打开”，按插件界面操作。各插件的专属说明和限制见对应目录中的 README。
4. 在插件窗口右上角菜单中可设置“独立窗口”“后台运行”和“随轻匣启动”。后台运行与随轻匣启动可分别开关。

只导入可信插件。应用代理等需要系统权限的功能会按操作提示请求授权。

## 插件

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| 拾影 | [`douyin-utools/`](douyin-utools/) | 解析并下载抖音公开视频 |
| frpc 电脑端 | [`frpc-utools/`](frpc-utools/) | 管理并同步 iostool 的 FRP 代理 |
| 密码盒子 | [`password-box-ui/`](password-box-ui/) | 轻匣插件格式示例 |
| 时间戳 | [`timestamp/`](timestamp/) | 时间戳与日期时间转换 |
| Hosts 管理 | [`hosts-tool/`](hosts-tool/) | 按环境编辑和切换系统 Hosts 配置 |
| uPrint 批量打印 | [`uPrint/`](uPrint/) | 批量打印 PDF、Word 文档和图片，可设置纸张、页边距、方向、份数及页码范围 |
| 应用代理 | [`proxy-bridge-plugin/`](proxy-bridge-plugin/) | 按应用配置代理、直连或拦截 |
| JSON 工坊 | [`json-tool/`](json-tool/) | JSON 格式化与树形检视、图片转 JSON、JSON 转图片还原与图卡导出 |
| Tailscale 异地组网 | [`tailscale-plugin/`](tailscale-plugin/) | Windows Wintun 虚拟网卡模式 Tailscale 异地组网，支持通过 `100.x.y.z` 虚拟局域网直连互通 |

开发者请先阅读[插件开发规范](toolbox/插件开发规范.md)。规范以轻匣当前实现为准，列明支持的插件结构、字段和宿主接口边界。

## 从源码运行

需要 Node.js。进入 `toolbox/` 后运行 `npm install`，再运行 `npm start`。

插件目录应保留 `plugin.json` 指定的入口、预加载脚本和资源。构建输出、依赖目录及本机测试数据不属于源码发布内容。

## 代码签名与隐私政策（Code Signing & Privacy Policy）

### 代码签名政策（Code Signing Policy）

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- **提交与代码审核（Committers and Reviewers）**：[lavieheureuse](https://github.com/lavieheureuse)
- **发布与签名审批（Approvers）**：[lavieheureuse](https://github.com/lavieheureuse)

本项目仅对通过公开仓库 `lavieheureuse/qingxia` 在 GitHub Actions 官方托管环境中构建的产物提交代码签名。

### 隐私政策（Privacy Policy）

- 轻匣主程序不收集、统计或上传用户的个人数据、使用行为或插件数据，也不包含任何广告或遥测组件。
- 仅在用户主动触发“GitHub 导入”“检查更新”或内置下载更新时，才会向 GitHub 官方接口发起只读网络请求；各独立插件的网络与本地文件访问行为受其自身功能与用户配置控制。
- 插件配置与用户数据均保存在用户本机目录（`plugin-data/`），不会回传给开发者。

### 开源协议（License）

本项目采用 [MIT License](LICENSE) 开源。
