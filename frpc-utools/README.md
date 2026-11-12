# iostool · frpc 电脑端（uTools 插件）

把 iostool 手机端发布的 FRP 代理，在这台电脑上自动拉取、校验、生效并回传状态。
它是 `iostool/pc/frp_sync.py` 的图形化替代：不用装 Python、不用配计划任务，在 uTools 里点一下就能用。

## 三端是怎么配合的

```
手机 iostool（编辑代理）
        │  POST /frp/config   (Bearer phoneToken)
        ▼
服务器配置中转（已部署，注入 [common] + frps token）
        │  GET /frp/config?pcId=   (Bearer pcToken)
        ▼
本插件（电脑端）：拉取 → frpc verify → 备份 → 替换 → 重启 frpc → POST /frp/status
        ▲
        └──────────── 手机状态页读 GET /frp/status?pcId= 显示「已生效 vN / 失败原因」
```

- 手机和电脑都能编辑代理：电脑端改动会「发布」到服务器（版本 +1），手机端刷新后看到同一份配置；电脑端发布后自动拉取应用。
- 新增一个之前没发布过的远程端口时，服务器会自动重建 frps 容器补端口（docker 不能热加端口），期间隧道会短暂断开，几秒后自动恢复。
- 插件不接触、不保存 frps token；pcToken 只用于调用你自己的中转接口。
- frps 版本 0.71.x 对应 frpc 0.71.1（插件默认下载这个版本，可改为自定义路径）。

## 安装（uTools 8 / 7.8）

开发模式加载（推荐自己用）：

1. 打开 uTools → **设置 → 开发者 → 插件应用开发**（不同小版本叫法略有差异，找「新建/加载本地插件」）。
2. 选择本目录（含 `plugin.json` 的 `frpc-utools` 文件夹）。
3. 回到 uTools 搜索框输入 `frpc` 进入插件。

打包分发：`node scripts/pack.cjs` 会在 `dist/` 生成 `frpc-utools-<版本>.zip`，解压后同样用开发者模式加载。

## 首次使用

1. 插件第一次打开时 `frpc 程序` 显示缺少 → 点「下载 frpc」（默认 0.71.1，从 GitHub 下载，失败会自动换镜像；也可以「指定路径」用已有的 frpc.exe）。
2. 展开「连接设置」，确认：
   - API 地址：`http://103.47.80.133`（你的中转服务，默认已填）
   - 电脑 ID：`pc-home`（必须和手机端一致）
   - 电脑 Token：服务器 `/etc/frp-clients/tokens.json` 里这台电脑的 `pcToken`（**必填**，只保存在本机）
3. 点「测试连接」确认能拉到服务器上的配置版本。
4. 点「立即同步」：拉取 → 校验 → 替换 → 启动 frpc → 回传状态。手机端状态页随即可见「已生效 vN」。
5. 需要长期生效就打开「自动同步」（默认 45 秒一次；版本没变且 frpc 在跑时会跳过，不会反复重启）。打开「启动时自动同步」后，插件启动时会立即同步一次并继续定时同步。

## 同步行为（和 frp_sync.py 一致）

在支持 `utools.onPluginExit` 的轻匣中，未开启“后台运行”时关闭插件会停止 frpc；开启后关闭窗口只隐藏页面。退出轻匣时插件会停止 frpc 并保留配置。使用不支持该退出接口的旧宿主时，需要在退出前手动停止 frpc。

- 每次同步先写 `run/frpc.toml.new` 再执行 `frpc verify`，通过后才备份旧配置（`frpc.toml.bak`）并原子替换。
- 校验失败、启动失败：**保留旧配置和旧 frpc 进程**，把可读错误回传手机，不拿坏配置反复重启。
- 版本号记录在 `run/frpc.toml.version`，版本没变且 frpc 存活时跳过重启。
- 要在轻匣启动时自动同步，还需在插件窗口菜单开启「随轻匣启动」；关闭窗口后继续同步需开启「后台运行」。宿主完全退出后同步会停止。
- 插件窗口没开时不轮询；需要真正后台常驻时，可以继续用原来的计划任务方案（见下方「与旧方案共存」）。

## 数据目录

`%APPDATA%\uTools\frpc-utools\`（uTools 用户数据目录下）

```
settings.json          连接配置 / frpc 路径 / 自动同步设置（pcToken 仅混淆保存，不是加密）
logs/sync.log          插件的同步日志
```

生效配置位于插件目录的 `run/frpc.toml`，备份、版本记录、进程信息和 frpc 日志也位于 `run` 中。下载的 frpc 默认位于插件目录的 `bin/frpc.exe`。首次切换时复制旧目录中的运行文件和已下载程序，旧文件保留；手动指定的程序路径不变。

## 安全

- pcToken 落盘前做混淆（`utf8:base64`），只用于这台电脑自己的配置；不要把它发到公开地方。
- 日志、错误提示、状态接口里都不会出现 pcToken 或 frps token 明文。
- 配置由服务器注入 `[common]`，插件不持有 frps token，也不调用 frps 管理面。
- 插件零 npm 依赖，渲染进程无法直接联网（CSP `connect-src 'none'`），所有网络都在 preload 里发。

## 与旧方案共存

如果之前跑过 `pc/install-windows.ps1`，会有一个登录自动运行的计划任务 `iostool-frp-sync`。
它和本插件都会管理 frpc，**同时开会抢配置和端口**。二选一：

- 用本插件：先停掉旧任务
  ```powershell
  schtasks /Delete /TN "iostool-frp-sync" /F
  ```
- 继续用旧脚本：就不要在插件里启动 frpc。

## 排障

- 同步失败看插件「同步日志」页签：每一步都有记录（拉取 → 版本比对 → 校验 → 替换 → 重启 → 回传）。
- `frpc` 起不来看「frpc 日志」页签，或直接看 `run/frpc.log`。
- 401/未授权：pcToken 不对，或服务器 tokens 文件里没有这个 pcId。
- 404/还没有发布配置：先在手机端发布一次。
- 端口被占用、frps 未发布该远程端口：手机端状态页会显示回传的错误。
- 报「无法连接服务器：Failed to fetch」：旧版本问题，原因是 uTools preload 里的全局 `fetch` 受插件页面 CSP 限制。
  宿主网络请求必须走 `core/node-fetch.cjs`（Node `http/https` 实现），不要改回全局 fetch。

## 开发

```bash
node --test tests/*.test.cjs   # 单元 + 真实 frps/frpc e2e（71 项）
node scripts/check.cjs         # 插件结构 / CSP / 零依赖 / 语法 自检
node scripts/pack.cjs          # 打包 dist/frpc-utools-<版本>.zip
```

网络一律走 `core/node-fetch.cjs`（Node `http/https` 实现）。不要用 preload 里的全局 `fetch`：
它在 uTools 里是渲染进程的 fetch，会被插件页面 CSP `connect-src 'none'` 拦截（真机表现为 `Failed to fetch`）。

实现规格见同级目录 `../SPEC-SYNC.md`。
