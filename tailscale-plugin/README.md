# Tailscale 异地组网（轻匣插件）

在 Windows 电脑上通过轻匣直接运行与管理 **Tailscale（Wintun 真实虚拟网卡模式）**，无需在系统托盘常驻原版 Tailscale 客户端，即可在多台电脑与移动设备之间建立低延迟 UDP P2P 虚拟局域网。

## 核心特性

1. **真实 Wintun 虚拟网卡（非代理模式）**：
   - 使用 `--tun=Tailscale` 拉起 `tailscaled.exe`，为系统分配真实的 `100.x.y.z` 虚拟网卡地址。
   - **局域网直连**：可用于远程桌面（RDP / RustDesk 等）、SSH、SMB 文件共享、NAS 与各类内网服务，直接通过 `100.x.y.z` 互通。
2. **数据与控制通道隔离**：
   - 所有配置、内核文件、状态目录（`--statedir`）、进程记录与日志均保存在轻匣专属数据目录（`utools.getPath('pluginData')/com.qingxia.tailscale`），绝不写入插件代码目录。
   - 使用独立受保护命名管道 `\\.\pipe\ProtectedPrefix\Administrators\QingxiaTailscale\tailscaled`，不污染系统原版 Tailscale 状态目录。
3. **内核按需下载与 SHA-256 校验**：
   - 不随仓库携带大体积二进制，符合轻匣 GitHub 导入限制。
   - 支持一键从 Tailscale 官方仓库（`pkgs.tailscale.com/stable`）下载对应架构的官方 MSI、校验 `.sha256` 哈希并通过 `msiexec /a` 无服务解包提取 `tailscaled.exe`、`tailscale.exe` 与 `wintun.dll`；也支持手动指定本地已包含上述 3 个文件的目录。
4. **严格进程身份核验与生命周期清理**：
   - 发起 UAC 管理员授权或文件选择框前自动调用 `utools.setPluginBusy(true)`，防止插件失焦关闭。
   - 持久化记录 `PID + 进程名 + 启动时间戳（Ticks）`，退出清理前严格核验身份，**绝不按进程名批量结束，不误杀系统原版 Tailscale 服务**。
   - 未开启“后台运行”关闭插件窗口，或退出轻匣时，自动停止由本插件启动的 `tailscaled` 并清理虚拟网卡与 DNS 状态。

## 常见问题排查

- **与原版 Tailscale 冲突**：若本机已安装并运行系统原版 `Tailscale` 服务，启动前会检测到冲突并拦截，请先停止系统原版服务后再启动本插件。
- **与代理软件 TUN 模式冲突**：若同时开启 Clash / Mihomo / sing-box / v2rayN 等软件的 TUN 模式或 Fake-IP（`100.64.0.0/10`），请在代理软件中将 `100.64.0.0/10` 网段及 `tailscaled.exe` 加入直连/Bypass 规则。
- **设备一直显示 DERP 中继**：Tailscale 按需建立 UDP 直连，无业务流量时常显示为 DERP；可点击设备列表右侧的 **Ping 探测** 触发 UDP 打洞并查看往返延迟。
- **UAC 管理员授权被取消**：创建/停止 Wintun 虚拟网卡需要管理员权限，如误点取消，界面会保持安全状态并提示重试。
