# 桌面打包说明

当前采用 **Electron 桌面壳 + FastAPI 后端子进程（sidecar）** 方案：

- `desktop/` 是 Electron 主进程：负责窗口、托盘、单实例、后端子进程生命周期、下载/外部协议、更新安装协调和退出清理。
- 后端使用 PyInstaller `onedir` 构建为 sidecar，放在 Electron 的 `extraResources` 中，程序资源和用户数据分离。
- Windows 通过 Electron Builder 的 NSIS 生成安装程序，macOS 通过 Electron Builder 生成 `.dmg`。

## 构建

先构建前端：

```bash
cd frontend
npm run build
```

安装打包工具：

```bash
python -m pip install pyinstaller
cd desktop && npm ci && cd ..
```

Windows PowerShell：

```powershell
.\packaging\build-windows.ps1
```

macOS（在对应架构的 Mac 上执行）：

```bash
./packaging/build-macos.sh arm64    # Apple Silicon
./packaging/build-macos.sh x86_64   # Intel
```

输出目录：`artifacts/`。Windows 生成 `MeimeiWorkbench-Setup-Windows-x64.exe`，macOS 生成对应架构的 `.dmg`。

构建顺序固定为：`Vue build → PyInstaller sidecar（build/backend-sidecar/）→ Electron Builder → 签名/公证 → artifacts/`。Python sidecar 位于 Electron `Contents/Resources/backend/`（Windows 为 `resources/backend/`），不会打进 `app.asar`。

## 本地开发桌面壳

开发模式下 Electron 直接启动源码后端（`python run.py --desktop-child`），不需要先打包：

```bash
cd desktop
npm install
npm run dev
```

Electron 自动打开工作台窗口；后端日志写入 Electron 用户数据目录下的 `backend.log`。

## GitHub Actions 发布

仓库包含两条流水线：普通分支和 Pull Request 会运行测试、前端构建、浏览器冒烟和 Electron 冒烟；推送 `v*` 标签时会并行构建 Windows x64、macOS Apple Silicon 和 macOS Intel 安装包，并自动创建 GitHub Release。

确定版本号后，在本地执行：

```bash
git tag v0.3.0
git push origin v0.3.0
```

如果暂时只想验证流水线，也可以在 GitHub Actions 页面手动运行 `Build desktop releases`。正式发布前需要在 GitHub Actions Secrets 配置：

- Windows：`WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD`
- macOS：`APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_PASSWORD`

带 `v*` 标签的发布会在 Secrets 完整时自动执行签名和 macOS 公证；没有凭证时仍会完成构建并发布未签名安装包，Release 说明会明确标注安全状态。未签名包仅建议在可信环境中测试使用。

发布流水线行为：

| 操作 | 结果 |
|---|---|
| 推送 `main` 或 `codex/**` 分支 | CI：后端测试、前端构建、浏览器冒烟、Electron 冒烟 |
| 创建并推送 `v*` 标签 | 构建三个平台安装包并创建 GitHub Release |
| 手动运行 `Build desktop releases` | 只构建并上传 Actions Artifacts，不创建 Release |

完整流程见 [`docs/开发与发布流程.md`](../docs/开发与发布流程.md)。

## 启动模式

桌面安装包双击后直接打开 Electron 工作台窗口，**不再自动打开外部浏览器**。程序默认监听可信局域网地址，手机和平板连接同一 Wi-Fi 后，在工作台右上角点击“手机访问”生成 5 分钟有效的单次配对二维码即可访问。

- 点击窗口关闭按钮会隐藏到系统托盘，手机访问和微信消息循环继续运行。
- 托盘菜单提供“打开工作台”和“退出工作台”；只有“退出工作台”才停止后端服务。
- 再次启动应用（或点击 macOS Dock 图标）会重新显示已有窗口，不会创建第二个后端。
- 默认端口为 5000，被占用时自动选择后续端口；Electron 始终通过 `127.0.0.1` 访问工作台。
- 浏览器开发模式（`python run.py`）仍然保留，用于开发调试和手机/平板访问。

## 用户数据位置

开发模式继续使用项目根目录的 `data/` 和 `知识库/`。

打包模式使用系统用户数据目录：

| 系统 | 默认目录 |
|---|---|
| Windows | `%LOCALAPPDATA%/MeimeiWorkbench/` |
| macOS | `~/Library/Application Support/MeimeiWorkbench/` |

Electron 自身缓存使用独立的 `MeimeiWorkbench-Electron` 目录，不会覆盖后端数据目录。

也可以通过环境变量指定位置：

```bash
WORKBENCH_DATA_DIR=/path/to/data MeimeiWorkbench
WORKBENCH_KB_DIR=/path/to/知识库 MeimeiWorkbench
```

数据库、备份和知识库都属于用户数据，不会被前端重新构建、程序升级或卸载删除。

## 更新机制

- 后端负责检查更新、升级前数据库备份、下载和 SHA-256 校验；校验通过后进入 `ready_to_install` 状态。
- Electron 通过受限 IPC 取得已校验安装包，关闭窗口和后端后启动安装器（Windows 为 NSIS 安装器，macOS 为更新助手脚本）。
- 安装包哈希不匹配时不会执行安装，并立即删除下载文件。
- macOS 更新助手会替换 App，并在新程序无法启动时恢复旧 App。

## 当前打包边界

- 未签名 macOS 安装包可能需要在“系统设置 → 隐私与安全性”中手动允许打开；Windows 可能显示 SmartScreen 提示。
- Inno Setup（`installer.iss`）和 Python 托盘保留为过渡期回退方案，Electron 安装包完成实机验收后清理。
- 正式分发要求 Windows 签名以及 macOS 签名、公证；未签名构建只用于可信环境测试。
