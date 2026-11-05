# utool

我的 uTools 插件集合，每个插件一个目录，各自独立、零 npm 运行时依赖。

## 插件目录

| 目录 | 插件 | 说明 |
| --- | --- | --- |
| [`douyin-utools/`](douyin-utools/) | 拾影 · 抖音视频下载 | 粘贴抖音公开视频链接，先预览再下载到本地。按需启动本机 Chrome / Edge 的独立引擎，读完即退出，不使用 uTools 隐藏浏览器，也不读取日常浏览器资料。 |
| [`frpc-utools/`](frpc-utools/) | iostool · frpc 电脑端 | 与 iostool 手机端联动：拉取手机发布的 FRP 代理、校验并运行 frpc、回传状态；电脑端也可以新增/编辑代理并发布（版本 +1，手机端同步可见）。 |

## 目录约定

- 每个插件目录自带 `plugin.json`、`preload.js`、前端文件、`core/`、`tests/`、`scripts/`，可单独打包成源码 ZIP 交给 uTools 开发者工具导入。
- 插件之间不共享运行时依赖；公共能力如有需要再单独抽取。
- 源码包不包含登录资料、Cookie、媒体签名地址、真实下载样本或本机路径。

## 开发与检查

在某个插件目录内：

```text
npm run check     # 静态检查：manifest、分享正则、CSP、JS 语法
npm test          # node --test
npm run pack      # 生成源码 ZIP（不是 .upx）
```

`.upx` 仍需通过 uTools 开发者工具导出。

## 许可与使用范围

各插件仅用于下载自己拥有或已获授权的公开内容，不提供绕过登录、验证码、付费或 DRM 的能力。
