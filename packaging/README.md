# 桌面打包说明

当前采用 **Electron 桌面壳 + Node.js 后端（utilityProcess）** 方案：

- `desktop/` 是 Electron 主进程：负责窗口、托盘、单实例、后端子进程生命周期、下载/外部协议、更新安装协调和退出清理。
- Node.js 后端运行在 Electron `utilityProcess` 中（入口 `dist/entry.js --desktop-child --lan`），资源打包在 Electron 的 `extraResources`（`resources/server/`），程序资源和用户数据分离；不再包含 Python/PyInstaller sidecar。
- 开发模式（未打包）使用系统 Node 运行 `server/dist/entry.js`：`server/node_modules` 为系统 Node ABI；打包模式依赖 `build/server-bundle/` 中为打包 Electron ABI 重建过的原生模块（better-sqlite3）。
- Windows 通过 Electron Builder 的 NSIS 生成安装程序，macOS 通过 Electron Builder 生成 `.dmg`。

## 构建

`scripts/build-node-bundle.sh`（macOS/Linux）或 `scripts/build-node-bundle.ps1`（Windows）会依次：使用 `.nvmrc` 的 Node 22 构建前端和 Node 后端 → 安装锁定的 Electron 打包工具 → 组装 `build/server-bundle/`（dist + static + app-version.json + 生产依赖）→ 使用本地锁定的 `@electron/rebuild` 将 better-sqlite3 重建为打包 Electron 的 ABI，并立即用 Electron 实际加载校验。

如需单独运行 `electron-builder`，先安装桌面打包工具；标准打包脚本会在缺少这些工具时自动执行同样的安装：

```bash
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

macOS 构建脚本会根据 `desktop/assets/icon.png` 自动生成临时 `icon.icns`；无需手工提交生成的图标文件。Intel 构建会将 Electron Builder 的 `x64` 输出统一命名为发布约定的 `x86_64`。

输出目录：`artifacts/`。Windows 生成 `MeimeiWorkbench-Setup-Windows-x64.exe`，macOS 生成对应架构的 `.dmg`。

构建顺序固定为：`Vue build → Node 后端编译（build/server-bundle/）→ Electron Builder → 签名/公证 → artifacts/`。Node 后端资源位于 Electron `Contents/Resources/server/`（Windows 为 `resources/server/`），不会打进 `app.asar`。应用版本唯一来源为构建时的 `APP_VERSION`，同步写入 `server-bundle/static/app-version.json` 与桌面应用版本。
