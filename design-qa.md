# 配置档案卡片视觉 QA

## Comparison target

- Source visual truth: `/var/folders/_h/dn80m6pj3cnch_sx0rz4l7740000gn/T/codex-clipboard-e2c28501-000d-4d94-8f48-d6b7a7442004.png`（993 × 341）以及 `/var/folders/_h/dn80m6pj3cnch_sx0rz4l7740000gn/T/codex-clipboard-caf94974-9bc2-4342-a78c-5c810257a652.png`（1006 × 99）。
- Implementation: `/Users/mika/project/workbench/output/playwright/agent-profiles-1000.png`（1000 × 700，CSS viewport 1000 × 700，device scale 1）以及 `/Users/mika/project/workbench/output/playwright/agent-config-editor.png`（1000 × 700，CSS viewport 1000 × 700，device scale 1）。
- State: AI 设置页，两个配置档案，默认配置为当前使用状态；另一个配置显示“使用此配置”。
- Normalization: 参考图为配置列表局部截图，实施图为同宽的完整设置页截图；比较聚焦配置卡片区域，不比较页面外壳。

## Comparison evidence

- Full-view: 配置区域位于模型连接卡片上方，配置列表、当前状态和创建入口层级清晰。
- Focused region: 两张卡片均使用圆角边框、卡片间距、左侧拖拽提示、配置图标、名称/URL 两行信息；当前卡片使用浅蓝背景和蓝色边框，并显示“使用中”；非当前卡片提供“使用此配置”。
- Interaction evidence: 浏览器验证了“新建配置 → 创建并使用 → 点击另一张卡片的使用此配置 → 当前使用状态切换”的完整路径，并验证当前卡片点击编辑后跳转到独立的 `/agent/config/:profileId` 页面；编辑页提供返回配置列表和保存配置入口；控制台 0 errors、0 warnings。

## Required fidelity surfaces

- Fonts and typography: 复用工作台现有字体、字号和字重；配置名称突出，URL 使用蓝色辅助信息层级。
- Spacing and layout rhythm: 卡片采用 10px 间距、14px 圆角、12–14px 内边距；操作区固定在右侧，窄屏时允许换行。
- Colors and visual tokens: 选中态采用现有 primary 色系的浅蓝背景和边框；URL、成功状态和辅助文字复用现有 token。
- Image quality and asset fidelity: 参考图的品牌头像不是本项目现有资产；实现复用项目已有 Lucide 图标和统一图标容器，没有伪造品牌 Logo。
- Copy and content: 使用“配置档案”“使用中”“使用此配置”“当前使用”等中文操作文案，覆盖新增、切换、复制、编辑 Key 和删除动作。
- Navigation and editing: 配置列表只承担档案管理，新增和编辑进入独立页面，避免多个配置表单同时堆叠；编辑页保留当前 Key 的掩码状态，留空保存时由后端保留原 Key。

## Findings

无 P0/P1/P2 问题。

## Follow-up polish

- [P3] 如果后续需要完全复刻 CC-switch，可为不同模型服务补充真实品牌图标，并增加拖拽排序；当前拖拽提示仅保持参考图的视觉结构，排序不是本次需求的一部分。

## Comparison history

- Initial implementation: 下拉框形式不符合参考图的卡片列表交互。
- Fix: 改为配置卡片列表，增加当前态、使用按钮、复制和 Key 定位操作，并补充服务端安全复制接口。
- Post-fix evidence: `output/playwright/agent-profiles-1000.png`，交互路径验证通过。
- Latest refinement: 将配置编辑表单从列表页拆到 `/agent/config/new` 和 `/agent/config/:profileId`，配置卡片的编辑/Key 操作统一跳转到编辑页。
- Latest evidence: `output/playwright/agent-config-editor.png`，独立编辑页的返回与保存入口已验证。

final result: passed
