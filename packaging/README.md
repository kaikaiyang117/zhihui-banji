# 桌面打包说明

当前采用 PyInstaller `onedir` 方案：程序文件和用户数据分离。Windows 通过 Inno Setup 生成安装程序，macOS 通过 `hdiutil` 生成 `.dmg`。

## 构建

先构建前端：

```bash
cd frontend
npm run build
```

安装打包工具：

```bash
python -m pip install pyinstaller
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

## GitHub Actions 发布

仓库包含两条流水线：普通分支和 Pull Request 会运行测试与前端构建；推送 `v*` 标签时会并行构建 Windows x64、macOS Apple Silicon 和 macOS Intel 安装包，并自动创建 GitHub Release。

确定版本号后，在本地执行：

```bash
git tag v0.3.0
git push origin v0.3.0
```

如果暂时只想验证流水线，也可以在 GitHub Actions 页面手动运行 `Build desktop releases`；正式发布前仍需补充 Windows/macOS 签名、公证和自动更新。

## 启动模式

默认只允许本机访问：

```bash
MeimeiWorkbench
```

允许同一局域网的手机和平板访问：

```bash
MeimeiWorkbench --lan
```

也可以覆盖端口：

```bash
MeimeiWorkbench --lan --port 5000
```

局域网模式启动时会生成一次性访问令牌，并打印带令牌的访问地址；前端会将令牌保存在当前浏览器中。该模式仍只适合可信网络，不要把端口映射到公网。后续还可以补充固定 PIN、设备管理和退出配对。

## 用户数据位置

开发模式继续使用项目根目录的 `data/` 和 `知识库/`。

打包模式使用系统用户数据目录：

| 系统 | 默认目录 |
|---|---|
| Windows | `%LOCALAPPDATA%/MeimeiWorkbench/` |
| macOS | `~/Library/Application Support/MeimeiWorkbench/` |
| Linux | `~/.local/share/MeimeiWorkbench/` |

也可以通过环境变量指定位置：

```bash
WORKBENCH_DATA_DIR=/path/to/data MeimeiWorkbench
WORKBENCH_KB_DIR=/path/to/知识库 MeimeiWorkbench
```

数据库、备份和知识库都属于用户数据，不会被前端重新构建或程序升级覆盖。

## 当前打包边界

- 当前是可验证的 `onedir` 打包配置，签名、公证和自动更新暂未加入。
- Windows 使用 Inno Setup 生成安装程序；macOS 使用 `hdiutil` 生成 DMG。当前仍不包含签名、公证和自动更新。
- Windows 构建保留控制台窗口，便于查看启动地址和局域网提示；macOS 应用会自动打开浏览器。
- 现有项目中的 `data/workbench.db` 不会自动复制到打包后的用户目录；首次发布需要提供一次数据导入/迁移步骤。
