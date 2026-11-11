# 轻匣

轻匣是一个 Windows 桌面工具箱，可以导入和管理本地插件。本仓库包含轻匣主程序、插件开发规范和示例插件。

## 下载

在 [Releases](https://github.com/lavieheureuse/qingxia/releases) 下载轻匣安装版或免安装版。源码位于 `toolbox/`。

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

开发者请先阅读[插件开发规范](toolbox/插件开发规范.md)。规范以轻匣当前实现为准，列明支持的插件结构、字段和宿主接口边界。

## 从源码运行

需要 Node.js。进入 `toolbox/` 后运行 `npm install`，再运行 `npm start`。

插件目录应保留 `plugin.json` 指定的入口、预加载脚本和资源。构建输出、依赖目录及本机测试数据不属于源码发布内容。
