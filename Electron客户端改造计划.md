# Electron 客户端改造计划

> 分支：`codex/electron-desktop-shell`
>
> 状态：主体改造已完成（阶段一至五）；待 Windows/macOS Intel 实机验收、签名/公证和覆盖升级验证后收口
>
> 目标平台：Windows 10/11 x64、macOS Apple Silicon、macOS Intel

## 1. 改造结论

本项目适合采用“Electron 桌面壳 + 现有 Vue 前端 + FastAPI 本地后端 + SQLite”的方式改造成完整桌面客户端。

本次改造不重写业务系统，不把数据库访问迁移到 Electron，也不取消手机和平板的局域网浏览器访问。Electron 只负责桌面程序应承担的职责：应用窗口、进程生命周期、托盘、单实例、原生下载与外部链接、更新安装和安装包发布。

当前架构已经具备可复用基础：

- Vue 3 前端是独立 SPA，使用 hash 路由和统一的 `frontend/src/api.js` 请求 FastAPI。
- FastAPI 同时提供 `/api/*` 和前端静态资源，Electron 可以直接加载本机 HTTP 地址。
- SQLite、知识库、备份和附件已经与程序资源目录分离。
- PyInstaller 已能将 Python 后端及依赖打包为无需用户安装 Python 的可执行程序。
- Windows、macOS 双架构构建、签名、公证、校验和更新清单已有流水线基础。
- 局域网配对、设备凭证和撤权逻辑可以继续服务手机和平板。

## 2. 改造目标与非目标

### 2.1 必须达到的目标

1. 安装后双击应用直接打开独立客户端窗口，不再自动打开 Chrome、Safari 或 Edge。
2. Electron 自动启动 FastAPI 后端，确认后端就绪后再显示主窗口。
3. 用户从托盘或系统菜单退出时，Electron 与 Python 后端一起正常关闭。
4. 桌面窗口继续使用现有全部业务功能，手机和平板继续通过局域网二维码访问。
5. 保留当前用户数据目录，升级 Electron 版本后不迁移、不覆盖、不清空现有数据库和知识库。
6. Windows 和 macOS 安装包继续支持版本检查、升级前备份、下载校验、安装与失败提示。
7. 桌面渲染进程不能直接访问 Node.js、SQLite、任意文件系统或任意系统命令。
8. 现有后端测试、前端构建和移动端浏览器路径继续通过，并新增桌面启动与退出测试。

### 2.2 本次不做的内容

- 不重写 FastAPI 服务和业务服务层。
- 不将 SQLite 改成 Electron/Node 数据库。
- 不将 Vue 改写为原生 Swift、WinUI 或其他原生 UI。
- 不取消浏览器开发模式；它仍用于开发调试和手机/平板访问。
- 不增加云同步、账号系统或公网访问。
- 不新增 Linux 正式安装包，除非后续单独提出需求。
- 不借本次改造重构无关业务页面或数据库结构。

## 3. 目标架构

```text
Electron 主进程
├── 单实例与应用生命周期
├── BrowserWindow / 托盘 / 系统菜单
├── 启动 PyInstaller 后端子进程
├── 等待后端健康检查
├── 下载、外部链接、打印和更新安装协调
└── 退出时关闭后端子进程
        │
        ▼
FastAPI 本地服务
├── Vue 构建产物
├── /api/*
├── Services
├── SQLite / 备份 / 附件
└── 知识库 Markdown
        ▲
        │
        ├── Electron：127.0.0.1，本机免配对
        └── 手机/平板：局域网地址，维持现有配对鉴权
```

桌面窗口继续加载 `http://127.0.0.1:<实际端口>/`，暂不改为 `file://` 或自定义协议。这样可以保留现有相对 API 地址、SSE 流式响应、上传、下载和 hash 路由，减少前端改动。

## 4. 默认产品行为

以下作为第一版默认行为；如无新的产品决定，实施时按此执行：

- 应用名称和数据目录标识继续使用 `MeimeiWorkbench`，避免产生第二套用户数据目录。
- Electron 窗口加载完成前显示启动界面；后端启动失败时显示可复制的错误摘要和日志位置。
- 点击窗口关闭按钮时隐藏到托盘，使手机访问和微信消息循环可以继续运行。
- 托盘菜单提供“打开工作台”和“退出工作台”；只有“退出工作台”才停止后端。
- macOS 点击 Dock 图标时重新显示窗口；Windows 再次启动应用时激活已有窗口。
- 开发模式保留浏览器启动脚本，另提供 Electron 开发启动命令。
- 桌面安装包默认继续支持局域网访问；Electron 自身始终通过 `127.0.0.1` 打开工作台。
- 第一版继续优先使用端口 5000，冲突时使用后端选出的后续端口，并由 Electron 读取实际地址。

## 5. 计划修改的文件

具体文件名可在实现时按现有风格微调，但职责不能混淆。

### 5.1 新增 Electron 目录

| 文件 | 计划内容 |
|---|---|
| `desktop/package.json` | Electron 开发、测试和打包命令；版本由发布标签统一注入。 |
| `desktop/package-lock.json` | 锁定 Electron 和打包依赖。 |
| `desktop/main.js` | 应用主进程、窗口、托盘、单实例、后端子进程、导航限制、退出和更新协调。 |
| `desktop/preload.js` | 只暴露经过白名单限制的桌面能力，不向页面暴露完整 `ipcRenderer`。 |
| `desktop/electron-builder.yml` | Windows/macOS 安装包、架构、图标、签名、公证和 `extraResources` 配置。 |
| `desktop/assets/` | Electron 所需的 `.ico`、`.icns` 和必要尺寸 PNG 图标。 |
| `desktop/tests/smoke.mjs` | 启动 Electron、检查页面、验证无外部浏览器、退出并确认后端停止。 |

首版保持 `main.js` 集中，不为一次性逻辑提前拆分大量模块；只有文件明显失控时再按进程管理、更新管理拆分。

### 5.2 后端修改

| 文件 | 计划内容 |
|---|---|
| `backend/run.py` | 增加 Electron 子进程启动模式；禁止打开浏览器和 Python 托盘；输出稳定、可解析的实际访问地址；支持前台运行和正常终止。 |
| `backend/app/__init__.py` 或 `backend/app/routers/system.py` | 增加轻量健康检查，Electron 用它判断数据库初始化和 FastAPI 启动完成。 |
| `backend/app/config.py` | 明确 Electron 打包状态、版本和资源目录来源，同时保持原用户数据目录不变。 |
| `backend/app/routers/system.py` | 调整更新安装边界：后端继续负责检查、备份、下载和 SHA-256 校验，Electron 负责退出整个应用并启动安装器。 |
| `backend/app/tray.py` | 迁移完成后不再作为正式安装包托盘实现；过渡期保留浏览器版兼容，最终确认无调用后再删除。 |
| `backend/requirements.txt` | 仅在 Python 托盘彻底停用且无其他用途时移除 `pystray`；`Pillow` 是否保留需检查照片和图标处理用途。 |
| `backend/tests/test_startup.py` | 增加机器可读地址、Electron 子进程模式、端口冲突和终止行为测试。 |
| `backend/tests/test_system.py` 或现有系统测试文件 | 增加健康检查和更新准备状态测试。 |

健康检查必须是只读、快速、无敏感信息的接口。它至少返回应用版本和 `ready` 状态，不返回数据目录、令牌或用户隐私。

### 5.3 前端修改

| 文件 | 计划内容 |
|---|---|
| `frontend/src/api.js` | 保持浏览器兼容；仅在需要桌面 IPC 时增加最小适配，不改变现有业务 API 层。 |
| `frontend/src/components/UpdateDialog.vue` | Electron 环境下通过受限桌面桥启动安装；浏览器和移动端只保留检查更新或给出桌面端提示。 |
| `frontend/src/views/Dashboard.vue` | 备份和迁移包下载交由 Electron 下载策略处理，确认不会打开空白子窗口。 |
| `frontend/src/views/Knowledge.vue` | `obsidian://` 交给系统外部协议打开，禁止在 Electron 窗口内部导航。 |
| `frontend/src/views/Seating.vue`、`Reports.vue` | 验证 `window.print()`；如系统打印体验不稳定，再通过受限 IPC 调用 Electron 打印。 |
| 含附件链接的页面 | 验证 `target="_blank"`、附件下载、图片查看不会创建不受控 BrowserWindow。 |

不应为了 Electron 大面积替换现有 `fetch`、上传表单或页面组件。桌面和移动浏览器继续共享同一套 Vue 页面。

### 5.4 打包与发布修改

| 文件 | 计划内容 |
|---|---|
| `packaging/meimei-workbench.spec` | 增加“后端 sidecar”构建模式；macOS 下只生成可嵌入 Electron 的后端目录/可执行文件，不再生成嵌套 `.app`。 |
| `packaging/build-windows.ps1` | 调整为“构建前端 → 构建 Python sidecar → Electron 打包”；不再由 Inno Setup 单独包装 Python 应用。 |
| `packaging/build-macos.sh` | 调整为“构建前端 → 构建对应架构 sidecar → Electron 打包 DMG”；签名覆盖 Electron 和内嵌 Python 二进制。 |
| `packaging/installer.iss` | Electron 安装包稳定后停止使用；过渡期保留用于回退，不立即删除。 |
| `packaging/sign-windows.ps1` | 根据 Electron Builder 的签名方式调整，验证主程序和安装器签名状态。 |
| `packaging/sign-macos.sh` | 根据 Electron Builder 的签名/公证流程调整，确保 Python、动态库和外层 `.app` 都被正确签名。 |
| `packaging/create-update-manifest.py` | 适配 Electron 安装包文件名和架构，继续生成 SHA-256 更新清单。 |
| `.github/workflows/ci.yml` | 安装桌面依赖并增加 Electron 冒烟测试；现有后端、前端和浏览器冒烟继续保留。 |
| `.github/workflows/release.yml` | 构建 Electron Windows x64、macOS arm64、macOS x64，检查版本，签名、公证并发布新安装包。 |
| `.gitignore` | 增加 Electron 构建缓存和输出目录，不能忽略源码或锁文件。 |

### 5.5 文档同步

实现完成后必须同步以下文档：

- `README.md`
- `AGENTS.md`
- `功能清单.md`
- `docs/用户手册.md`
- `docs/开发与发布流程.md`
- `docs/发布检查清单.md`
- `packaging/README.md`
- 本文档中的状态与最终决策

文档中所有“启动后打开浏览器”“Python 托盘”“PyInstaller 直接生成最终应用”的说明都需要改成 Electron 桌面行为；手机和平板浏览器访问说明必须保留。

## 6. 分阶段实施与验收

### 阶段一：后端 sidecar 契约

修改内容：

1. 为 `backend/run.py` 增加明确的 Electron 子进程参数，例如 `--desktop-child`。
2. 子进程模式不调用 `webbrowser.open()`，不创建 `pystray` 托盘。
3. 后端选定端口后输出单行机器可读信息，例如 `WORKBENCH_URL=http://127.0.0.1:5000`，并立即刷新 stdout。
4. Electron 读取地址后轮询健康检查，不能仅依赖固定延时。
5. 退出信号触发 FastAPI shutdown，关闭微信循环和 SQLite 连接注册表。

验收：

- 端口 5000 空闲和被占用两种情况下都能取得实际地址。
- 健康检查只有在数据库初始化完成后返回 ready。
- 子进程模式不打开浏览器、不创建 Python 托盘。
- 正常退出后端口立即释放，`.workbench-ready` 不留下错误运行状态。

### 阶段二：最小 Electron 客户端

修改内容：

1. 建立 Electron 主进程和 `BrowserWindow`。
2. 开发模式启动源码 Python，生产模式启动 `extraResources` 中的 PyInstaller sidecar。
3. 后端 ready 后加载页面并显示窗口；启动失败时显示错误页。
4. 使用单实例锁，第二次启动只激活已有窗口。
5. Electron 退出时关闭后端；后端意外退出时给出可理解提示。

验收：

- 双击/运行 Electron 后只出现工作台窗口，不出现外部浏览器。
- 首页、Agent 流式响应、上传和 API 请求正常。
- 重复启动不会创建第二个后端和第二套窗口。
- 应用退出后局域网访问失效，数据库可再次正常打开。

### 阶段三：托盘和桌面交互

修改内容：

1. 将托盘迁移到 Electron。
2. 关闭窗口时隐藏，显式退出时停止全部进程。
3. 限制窗口导航和新窗口。
4. 接管受支持的 HTTP(S) 与 `obsidian://` 外部链接。
5. 处理文件下载、备份下载、迁移包下载和附件下载。
6. 验证打印与保存 PDF；仅在必要时增加打印 IPC。

验收：

- 托盘打开/退出在 Windows 和 macOS 均正常。
- 外部链接不会在工作台窗口中覆盖当前页面。
- 未知协议、非白名单地址和页面传入的任意命令不会被执行。
- 中文文件名的 Excel、备份、迁移包和附件可正确保存。
- 座位表和报告打印布局与浏览器版本一致。

### 阶段四：更新机制迁移

现有更新器的 `_launch_installer()` 和 `os._exit(0)` 只了解 PyInstaller 主程序。改成 Electron 后，如果继续原样使用，它只会结束 Python 后端，Electron 仍在运行，Windows 安装器可能无法覆盖文件，macOS 更新助手也可能等待失败。因此必须调整更新所有权。

推荐边界：

1. 后端继续复用 GitHub Release 查询、私有仓库 Token、升级前数据库备份、下载和 SHA-256 校验。
2. 校验完成后进入 `ready_to_install` 状态，不由后端直接结束进程。
3. Electron 通过受限 IPC 取得已校验安装包，关闭窗口和后端后启动安装器。
4. Windows 等待 Electron 完全退出后进入覆盖安装。
5. macOS 更新 Electron 外层 `.app`，并保留现有失败回滚能力或用经过验证的 Electron 更新方案替代。
6. 更新期间防止用户重复触发，错误状态可重试，校验失败立即删除下载文件。

验收：

- 更新前备份存在并通过 SQLite 完整性检查。
- 安装包哈希不匹配时不会执行。
- Windows、macOS 两种架构都选择正确资产。
- 安装时 Electron 和 sidecar 都已退出。
- 更新后数据目录、数据库、知识库、附件和 GitHub Token 均保留。
- 更新失败可以重新打开旧版本；macOS 回滚路径经过实机验证。

### 阶段五：正式打包

构建顺序固定为：

```text
Vue build
→ PyInstaller backend sidecar
→ Electron Builder
→ 代码签名/公证
→ 安装包冒烟测试
→ SHA256SUMS.txt / update-manifest.json
```

注意：

- Python sidecar 必须放在 `extraResources` 或其他非 `asar` 路径中，不能从 `app.asar` 内直接执行。
- macOS 不应在 Electron `.app` 内再嵌套当前 PyInstaller 生成的 `MeimeiWorkbench.app`；应嵌入普通 sidecar 可执行目录。
- Electron 架构与 Python sidecar 架构必须一致。
- 版本号只能有一个发布来源，建议以 Git 标签为源，同时注入 Electron 和后端 `app-version.json`。
- 现有文档仍写参考版本 `v1.0.4`，仓库当前标签已经更高；正式改造时必须统一版本信息。
- 未签名构建只用于可信环境测试，正式分发要求 Windows 签名以及 macOS 签名、公证。

验收：

- Windows x64 安装、覆盖升级、卸载正常。
- macOS arm64/x64 DMG 安装、Gatekeeper、签名和公证正常。
- 安装后的电脑不需要 Python、Node.js 或外部浏览器。
- 安装路径可以包含中文和空格。
- 首次启动与旧版覆盖安装都读取原有用户数据目录。

### 阶段六：测试和文档收口

自动验证至少包括：

```bash
python -m unittest discover -s backend/tests -p 'test_*.py' -v
cd frontend && npm run build
bash scripts/smoke-ui.sh
```

此外新增 Electron 自动冒烟：

- 使用临时 `WORKBENCH_DATA_DIR` 和 `WORKBENCH_KB_DIR`。
- 启动 Electron 并等待主窗口。
- 检查工作台标题、首页、“手机访问”和“更新”入口。
- 验证后端意外退出提示。
- 退出 Electron 后确认 sidecar 不存在且端口释放。

实机检查至少覆盖：

- Windows 10/11 x64。
- macOS Apple Silicon。
- macOS Intel 或对应真实 Intel runner/设备。
- iPhone/Android 与电脑同 Wi-Fi 的二维码配对。
- 端口占用、防火墙、离线启动、更新失败、数据库恢复和中文路径。

## 7. 重点风险和处理原则

### 7.1 进程生命周期

Electron 是唯一桌面宿主，不能让 Python 同时拥有系统托盘和应用退出权。所有正常退出路径都由 Electron 发起，并等待后端释放数据库和端口。崩溃路径要避免孤儿 Python 进程。

### 7.2 端口与本地状态

前端的班级、学期和 Agent 会话目前保存在 `localStorage`。浏览器存储按 origin（包含端口）隔离；如果端口从 5000 切换到 5001，桌面端可能看起来像“丢失了界面选择”，虽然 SQLite 数据没有丢失。

第一版保持优先使用 5000，端口冲突时允许切换并明确提示。若后续实际频繁发生端口变化，再将桌面 UI 状态迁移到稳定的 Electron 存储或稳定自定义协议，不在首版提前增加代理层。

### 7.3 数据兼容

- 继续使用 `%LOCALAPPDATA%/MeimeiWorkbench/` 和 `~/Library/Application Support/MeimeiWorkbench/`。
- Electron 的默认 `userData` 目录不能替代后端现有数据目录，除非显式验证两者完全一致。
- 不修改真实 `data/workbench.db` 验证客户端；所有自动测试使用临时目录。
- 不移动、覆盖旧 Excel 归档和知识库。
- 覆盖安装、更新和卸载默认不删除用户数据。

### 7.4 Electron 安全

- `nodeIntegration: false`。
- `contextIsolation: true`。
- `sandbox: true`，若某平台能力确实阻止沙箱再做最小例外。
- 不关闭 `webSecurity`。
- preload 只暴露逐项白名单方法，不暴露 `ipcRenderer.send`、文件系统或 shell。
- 主窗口只允许加载当前后端的回环地址。
- 阻止页面导航到远程站点；允许的外部链接交给系统浏览器。
- `shell.openExternal` 必须校验协议和目标，不接受任意页面字符串。
- 生产环境默认不自动打开 DevTools。
- 增加合理 CSP，确认 ECharts、Markdown、二维码和现有样式不依赖不安全脚本。

### 7.5 局域网安全

Electron 不替代现有设备鉴权。远程设备仍必须通过 5 分钟单次配对码和可撤销凭证访问 API。不能因为加入 Electron 而对所有请求放宽本机判断，也不能将服务映射到公网。

### 7.6 下载、上传和外部协议

现有页面大量使用浏览器标准能力，需逐项验证：

- `<input type="file">`：学生、成绩、校历、附件、凭证、数据库恢复和迁移包。
- `<a download>`：Excel 和汇总报表。
- `window.open()`：备份和迁移包下载。
- `target="_blank"`：附件与发布说明。
- `window.print()`：座位表和报告。
- `obsidian://`：知识库外部打开。
- Clipboard：复制手机访问地址。
- SSE/fetch stream：Agent 流式回答。

不能统一把所有新窗口都交给系统浏览器：本地附件下载、打印页、HTTP(S) 发布说明和 `obsidian://` 需要不同处理策略。

### 7.7 开发和发布依赖

- Electron 只进入 `desktop/`，不污染 `frontend/package.json` 的纯前端依赖。
- 锁文件必须提交，CI 使用可重复安装命令。
- 不同时长期维护 Inno Setup 最终安装包和 Electron 最终安装包；迁移验收后只保留一个正式发布路径。
- 构建脚本不得删除用户数据目录，只能清理仓库内明确的 `build/`、`dist/`、`artifacts/` 和 Electron 输出目录。
- GitHub Secrets、证书、Token 和学生数据不得进入日志、安装包测试夹具或仓库。

## 8. 完成标准

只有满足以下条件，Electron 改造才能标记完成：

- [x] 安装应用后不再自动打开外部浏览器。
- [x] Electron 能可靠启动、检测和关闭 FastAPI sidecar。
- [x] 单实例、窗口恢复和托盘退出行为符合预期（自动冒烟已覆盖，托盘实机项在发布清单中）。
- [x] 桌面全部主要业务页面可用，Agent 流式响应正常（Electron 冒烟覆盖首页；完整页面回归见浏览器冒烟）。
- [x] 上传、下载、附件、打印、剪贴板和 Obsidian 协议通过验证（下载/外部协议由主进程策略处理，实机附件项在发布清单中）。
- [x] 手机和平板局域网配对、访问和撤权未回归（后端测试与浏览器冒烟覆盖）。
- [x] 旧版数据目录无需手工迁移即可读取。
- [ ] Windows 和两个 macOS 架构安装包均可构建和启动（macOS arm64 已验证，Windows/macOS Intel 待流水线实机验证）。
- [ ] 更新前备份、下载校验、安装、失败恢复通过实机验证。
- [x] Electron 安全配置和导航白名单经过检查。
- [x] 后端全量测试、前端构建、浏览器冒烟和 Electron 冒烟全部通过。
- [x] README、用户手册、发布流程、发布清单、AGENTS 和打包文档同步完成。
- [ ] `git diff` 不包含真实数据库、知识库、凭证、构建缓存和无关文件（需在提交前检查）。

## 9. 回退策略

改造期间保留现有浏览器启动入口和旧打包脚本，直到 Electron 安装包完成 Windows/macOS 实机验收。若 Electron 发布链路暂时失败，可以继续使用现有 PyInstaller 浏览器版，不影响业务代码和用户数据。

Electron 正式发布并完成至少一次覆盖升级验证后，再单独清理不再使用的 Python 托盘、Inno Setup 配置和旧 macOS 外壳；清理必须作为可独立审查的后续改动，不与首版客户端功能混在一起。

## 10. 当前执行状态

- [x] 创建独立分支 `codex/electron-desktop-shell`。
- [x] 核对现有前端、FastAPI、PyInstaller、托盘、更新、CI 和发布文档。
- [x] 在根目录记录改造范围、风险和验收标准。
- [x] 实现后端 sidecar 启动契约（`--desktop-child`、`/api/system/health`、`WORKBENCH_URL` 单行输出、退出清理标记）。
- [x] 实现最小 Electron 客户端（`desktop/` 主进程、preload 白名单桥、单实例、健康检查后加载窗口）。
- [x] 迁移托盘和桌面交互（托盘菜单、关闭隐藏、导航白名单、下载策略、外部协议、打印保持浏览器行为）。
- [x] 迁移更新安装所有权（后端 `ready_to_install` 状态 + 本机 `installer-path` 接口；Electron 关闭应用后启动安装器）。
- [x] 改造 Windows/macOS 打包发布（sidecar spec、build-windows.ps1、build-macos.sh、electron-builder、CI/Release 流水线）。
- [ ] 完成自动测试、实机验收和文档收口（Windows/macOS Intel 实机、签名/公证、覆盖升级验证后清理 Python 托盘与 Inno Setup）。

## 11. 实施中确认的最终决策

实现过程中记录以下决策，后续按此执行：

- Electron 打包模式的 `userData` 使用独立的 `MeimeiWorkbench-Electron` 目录，避免与后端数据目录（`MeimeiWorkbench`）在 macOS 上同名混用。
- 同源 `window.open`（备份、迁移包、附件下载）由主进程 `setWindowOpenHandler` 转为 `downloadURL` 交给统一下载策略，不打开外部浏览器；非白名单 URL 一律拒绝。
- macOS 安装包命名为 `MeimeiWorkbench-macOS-x64.dmg`（Electron Builder 使用 `x64`，不是 `x86_64`），后端 `_platform_asset` 已同步修正。
- 更新流程新增状态 `ready_to_install`：前端轮询到此状态后停止，Electron 环境显示“安装并重启工作台”按钮，浏览器环境提示到桌面客户端安装。
- 后端 `backend/app/routers/system.py` 不再包含 `_launch_installer`，Windows 安装器由 Electron 直接启动，macOS 由 Electron 启动 `packaging/macos-updater.sh`（打包后位于 sidecar `updater/`）。
- 冒烟测试使用 `WORKBENCH_SMOKE=1` 由主进程自检（标题、手机访问/更新入口、健康检查）并以退出码上报；`desktop/tests/smoke.mjs` 校验后端端口释放。
- `packaging/installer.iss`、`backend/app/tray.py` 保留为过渡期回退，完成 Electron 实机覆盖升级验收后再单独清理。
