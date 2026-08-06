# 桌面打包说明

当前采用 PyInstaller `onedir` 方案：程序文件和用户数据分离。Windows 通过 Inno Setup 生成安装程序，macOS 通过 `hdiutil` 生成 `.dmg`。

当前可用发布版本：[`v1.0.4`](https://github.com/aitia0718/workbench/releases/tag/v1.0.4)。该版本包含 Windows x64、macOS Apple Silicon 和 macOS Intel 安装包，但由于仓库尚未配置代码签名凭证，安装包为未签名版本。

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

如果暂时只想验证流水线，也可以在 GitHub Actions 页面手动运行 `Build desktop releases`。正式发布前需要在 GitHub Actions Secrets 配置：

- Windows：`WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD`
- macOS：`APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_PASSWORD`

带 `v*` 标签的发布会在 Secrets 完整时自动执行签名和 macOS 公证；没有凭证时仍会完成构建并发布未签名安装包，Release 说明会明确标注安全状态。未签名包仅建议在可信环境中测试使用。配置凭证后，无需修改流水线即可恢复签名发布。

发布流水线行为：

| 操作 | 结果 |
|---|---|
| 推送 `main` 或 `codex/**` 分支 | CI：后端测试、前端构建、浏览器冒烟测试 |
| 创建并推送 `v*` 标签 | 构建三个平台安装包并创建 GitHub Release |
| 手动运行 `Build desktop releases` | 只构建并上传 Actions Artifacts，不创建 Release |

完整流程见 [`docs/开发与发布流程.md`](../docs/开发与发布流程.md)。标签版本一旦创建，不要重复移动同名标签；如果发布失败，修复后使用新的补丁版本号。

## 启动模式

桌面安装包双击后默认开启局域网访问：

```bash
MeimeiWorkbench
```

程序会自动生成一次性访问令牌并打开本机浏览器；进入工作台后点击右上角“手机访问”，手机或平板连接同一 Wi-Fi 后扫描二维码即可访问：

```bash
MeimeiWorkbench --lan
```

`--lan` 仍保留用于手动排查。默认端口为 5000，若被其他程序占用，程序会自动选择后续可用端口。二维码只包含本次启动的访问令牌，请仅分享给可信设备。

也可以手动覆盖端口：

```bash
MeimeiWorkbench --lan --port 5000
```

局域网模式启动时会生成一次性访问令牌，并打印带令牌的访问地址；前端会将令牌保存在当前浏览器中。该模式仍只适合可信网络，不要把端口映射到公网。

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

- 当前是可验证的 `onedir` 打包配置；应用内检查更新、下载、SHA-256 校验和启动安装器已经加入。
- Windows 使用 Inno Setup 生成安装程序；macOS 使用 `hdiutil` 生成 DMG。配置 Secrets 后自动签名、公证，并生成 `update-manifest.json` 作为 GitHub API 限流时的更新检查兜底。
- 更新前会创建数据库备份；macOS 使用独立更新助手替换 App，并在新程序无法启动时恢复旧 App。
- Windows 构建保留控制台窗口，便于查看启动地址和局域网提示；macOS 应用会自动打开浏览器。
- 现有项目中的 `data/workbench.db` 不会自动复制到打包后的用户目录；首次发布需要提供一次数据导入/迁移步骤。
- 安装包是单机程序：卸载或升级不会主动删除用户数据，但仍建议升级前使用“备份数据”创建备份。
- 未签名 macOS 安装包可能需要在“系统设置 → 隐私与安全性”中手动允许打开；Windows 可能显示 SmartScreen 提示。
