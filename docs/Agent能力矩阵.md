# Agent 能力矩阵

这份矩阵是系统功能、Agent 工具和渠道权限的登记表。

> 当前基线（2026-08-20）：注册表共 33 个工具，工具契约按 `read_only`/`write_action` 和渠道过滤；数据库 schema v33；网页会话按操作者隔离，确认写入后自动读取业务状态验证。网页 Agent 对话入口已支持 `.xlsx` 上传、识别、预览和确认导入；Agent Excel 工具仍仅提供兼容提示，不直接执行导入。微信 iLink 文件消息、证据缩略图和移动设备兼容性仍需按发布清单人工验收。

## 使用规则

- 新增或修改系统能力时同步更新本表。
- 只有明确登记为“是”的渠道，才允许该渠道调用对应 Agent 工具。
- “微信端”是服务端权限，不是网页按钮状态；敏感信息和写操作必须在工具层拦截。
- 工具名称、参数、风险等级或对应业务服务变化时，必须同步更新测试。
- 所有教师业务只读工具都使用班级/学期上下文：网页 Agent 跟随顶部所选范围；微信 Agent 在尚未提供显式切换指令前使用首个未归档班级的当前学期。切换网页范围会清空网页 Agent 的旧会话，防止上下文串班。

## Agent Harness 可靠性规则

- 自然语言查询先经过意图归一化，再进入确定性路由或模型规划；“所有学生”“所有的学生”“全班学生”“学生名单”等表达应归入同一类批量查询意图。
- 计划执行前校验任务范围与工具是否匹配：全班/多学生问题不得退化为单个学生搜索或单个学生档案查询。
- 查询结果必须保留结构化计数和截断信息；批量查询因错误关键词返回空结果时，只允许自动纠正并重试一次。
- Agent 的展示计划、工具结果和最终回答属于同一条执行轨迹；修复问题时优先定位轨迹中的第一个错误，并将该 bad case 加入回归样例集。
- 只读工具优先使用批量查询、结构化返回和可验证结果；不得为了让模型“自己推理”而绕过服务端字段白名单和班级/学期范围。
- 注册表可以登记全部工具，但每次模型调用和模型规划只接收当前渠道允许的工具；微信不接收 `student_get_profile` 的工具定义。
- 网页会话由服务端创建为 `web:{用户摘要}:{会话}`，会话列表、读取、重命名和删除均按服务端操作者与渠道过滤；旧 `web:` 会话迁移后归属本机用户。
- 上下文压缩以用户回合为边界，保留工具调用与工具结果的对应摘要，不持久化模型隐式思维链。
- 后续问题中的“这个学生”等指代，优先解析为会话中最近明确提到的学号或姓名；学生搜索无结果、结果不唯一或工具失败时，计划步骤必须给出明确恢复提示，不把内部协议残片交给用户。
- 确认写入工具在同一事务内执行并重新读取业务状态；验证失败则回滚并标记操作失败，不向用户声称已经完成。
- 网页 Agent 的待确认写入在工具卡片中显示“确认写入 / 取消”按钮；按钮调用服务端确认接口，手动回复“确认 / 取消”作为不支持按钮渠道的兼容方式。

## 模型接入配置

- 模型连接配置使用本地 `agent-model.json` 的版本化配置档案存储，支持多个档案、当前档案切换、重命名和删除；旧版单配置会自动迁移为“默认配置”。
- 配置档案中的 API Key 只在本机保存，普通配置读取接口只返回是否已配置及掩码；用户在本机配置页显式点击小眼睛后，才通过本机专用接口临时读取当前档案 Key。保存时 API Key 留空表示保留当前值，不会把空值覆盖到本地凭据。
- 配置档案管理仅允许本机工作台页面访问，不作为网页 Agent 或微信 Agent 工具开放；当前 active 档案供共享 Agent 核心使用。

## 当前能力

| 系统能力 | 业务服务 | Agent 工具 | 网页点击 | 网页 Agent | 微信 Agent | 风险/确认 | 状态 |
|---|---|---|---:|---:|---:|---|---|
| 查询班级学生总数 | `get_class_student_count` | `class_student_count` | 是 | 是 | 是 | 只读 | 已接入 |
| 管理班级小组 | `groups` | 无（网页专用） | 是 | 否 | 否 | 学生关系写入；服务端校验班级/学期和同类型重复分组 | 已接入 |
| 管理宿舍房间、床位、寝室长、入住与查寝 | `dormitories` | 无（网页专用） | 是 | 否 | 否 | 学生住宿和在寝状态敏感数据；网页写入并记录审计，微信默认禁止 | 已接入 |
| 搜索学生 | `search_students` | `students_search` | 是 | 是 | 是 | 只读，返回基础信息 | 已接入 |
| 批量查询学生字段 | `query_students` | `students_query` | 是 | 是 | 是 | 只读；字段白名单；不返回电话、家庭住址和备注 | 已接入 |
| 聚合学生分布 | `aggregate_students` | `students_aggregate` | 是 | 是 | 是 | 只读；服务端分组统计，可返回学生名单摘要 | 已接入 |
| 查看学生档案 | `get_student_profile` | `student_get_profile` | 是 | 是 | 否 | 敏感信息，微信默认拒绝 | 已接入 |
| 查看学生时间线 | `get_student_timeline` | `student_get_timeline` | 是 | 是 | 是 | 只读，返回事件摘要 | 已接入 |
| 获取学生学期评语事实 | `comment_ai.build_student_term_contexts` | `student_term_comment_context` | 是 | 是 | 是 | 只读；只返回学期内成绩、异常考勤、行为记录和过程摘要，不返回家庭电话、住址和沟通原文 | 已接入 |
| 生成班级学期档案草稿 | `report_drafter.generate_draft` | 无（页面专用 AI 入口） | 是 | 否 | 否 | 只生成班级整体表现、下学期计划和班主任总结草稿；老师修改确认后才保存，不直接写入 | 已接入 |
| 查询考勤统计 | `get_attendance_summary` | `attendance_summary` | 是 | 是 | 是 | 只读 | 已接入 |
| 查询成绩统计 | `scores.score_summary` → `get_scores_summary` | `scores_summary` | 是 | 是 | 是 | 只读；按学生合法选科组合返回适用科目、总分、排名与变化，不暴露导入明细 | 已接入 |
| 登记学生选科 | `scores.apply_sichuan_312_preset`、`save_student_subjects_batch` | 无 | 是 | 否 | 否 | 网页教师主动写入；支持批量操作并记录审计，不开放给Agent | 系统已接入 |
| 查询统一工作项 | `work_items.list_work_items` → `get_tasks_list` | `tasks_list` | 是 | 是 | 是 | 只读；默认返回未关闭事项 | 已接入 |
| 查询家校沟通 | `get_communications_list` | `communications_list` | 是 | 是 | 是 | 只读，隐藏家长电话 | 已接入 |
| 查询校历 | `get_school_calendar` → `school_calendar.query_calendar` | `school_calendar_query` | 是 | 是 | 是 | 只读；按当前班级/学期返回日期安排 | 已接入 |
| 查询课程表与指定日期课程 | `timetable.listTimetable`、`timetable.daySchedule` | 无 | 是 | 否 | 否 | 只读；按当前班级/学期返回课程、教师、教室和临时变更 | 已接入 |
| 现场课堂点名预览 | `fieldOperations.startRollCall` | `start_roll_call` | 是 | 是 | 是 | 只读；自动绑定单一教师班级，日期/场景需校验 | 开发中 |
| 提交点名异常 | `attendance.save_daily` | `submit_roll_call_exceptions` | 是 | 是 | 是 | 写入；预览后必须确认；按点名会话解析学生并验证异常落库 | 开发中 |
| 首页近期考试 | `scores.listUpcomingExams` | `query_field_info(upcoming_exams)` | 是 | 是 | 是 | 只读；排除已结束考试并按日期排序 | 开发中 |
| 多班级教师课程/考试汇总 | `teacherClasses.getTeacherTimetable/getTeacherExams` | 无 | 是 | 否 | 否 | 只读；按教师关联班级汇总，网页专用 | 开发中 |
| Excel 上传、预览与确认导入 | `excelImportAssistant`、`excelSemanticAnalyzer` | Agent 工具仅兼容提示 | 是 | 否 | 否 | 网页 Agent 支持 `.xlsx`；本地规则先识别，模型只接收结构轮廓并补充白名单内候选/映射，规则优先且模型不可用时回退；临时状态绑定会话、SHA-256、工作表、班级和学期，预览确认后才提交并保留受保护错误报告；iLink 文件未接入 | 已接入 |
| 图片/截图证据 | `evidence` | `evidence_list` | 是 | 是 | 是 | 只读元数据；文件写入走网页/业务服务，所有者、学生范围、哈希和软删除校验 | 开发中 |
| AI 家校通知场景与内容生成 | `notificationTemplates`、`notificationDrafter` | 无（页面专用 AI 入口） | 是 | 否 | 否 | 后端结构只校验事实底稿；网页选择通知类型并调用 AI 生成可编辑文案，不提供模板管理或自动发送 | 开发中 |
| 家长消息回复前检查与草稿生成 | `parentReply`、`parentReplyDrafter` | 无（页面专用 AI 入口） | 是 | 否 | 否 | 敏感只读；只读取当前班级/学期脱敏事实；确定性规则匹配制度边界，模型仅可凭输入原文补充登记规则且不能降级；显示证据状态、待核实条件与投诉升级信号；机械化或越权草稿回退规则草稿；不自动发送，教师确认已发送后才复用现有沟通写入和证据服务 | 开发中 |
| 家长会/个别谈话准备 | `meetingPrep`、`meetingPrepDrafter` | 无（页面专用 AI 入口） | 是 | 否 | 否 | 敏感只读；学生必须在当前班级/学期范围内；同一筛选生成事实和方案，AI 建议引用事实编号，不发送电话与住址，不自动写回 | 已接入 |
| 教师常用工具入口 | `toolLinks` | `tool_link_search` | 是 | 是 | 是 | URL 仅允许 http(s)，名称唯一，写入需网页确认 | 开发中 |
| 创建待办 | `work_items.create_work_item` | `create_task` | 是 | 是 | 是 | 低风险写入；预览后必须确认；单条、幂等 | 已接入 |
| 记录家校沟通 | `communications.create_record` | `record_communication` | 是 | 是 | 是 | 写入；预览后必须确认；隐藏敏感联系人字段 | 已接入 |
| 保存单条考勤 | `attendance.save_daily` | `save_attendance` | 是 | 是 | 是 | 低风险写入；预览后必须确认；禁止批量 | 已接入 |
| 记录行为积分 | `points.create_entry` | `record_points` | 是 | 是 | 是 | 低风险写入；预览后必须确认；单条流水可撤销 | 已接入 |
| 修改/完成/取消待办 | `work_items.update_work_item` | `update_task` | 是 | 是 | 是 | 低风险写入；预览后必须确认；完成/取消必须填写结果 | 已接入 |
| 记录学生事件 | `p0.create_event` | `create_event` | 是 | 是 | 是 | 单条写入；预览后必须确认；可联动生成跟进待办 | 已接入 |
| 创建重点关注 | `p0.create_focus` | `create_focus` | 是 | 是 | 是 | 学生跟进写入；预览后必须确认；可联动生成复查待办 | 已接入 |
| 记录班会 | `education.create_meeting` | `create_meeting` | 是 | 是 | 是 | 结构化记录；预览后必须确认；可生成行动项 | 已接入 |
| 记录班级活动 | `education.create_activity` | `create_activity` | 是 | 是 | 是 | 结构化记录；预览后必须确认；可生成跟进待办 | 已接入 |
| 记录班主任日志 | `education.create_diary` | `create_diary` | 是 | 是 | 是 | 本地日志写入；预览后必须确认 | 已接入 |
| 创建知识库笔记 | `knowledge.create_note` | `create_knowledge_note` | 是 | 是 | 是 | 本地 Markdown 文件写入；预览后必须确认 | 已接入 |
| 创建班级任务 | `class_tasks.create_task` | `create_class_task` | 是 | 是 | 否 | 为明确学生范围批量生成收集项；网页/本地预览后必须确认 | 已接入 |

## 工具参数摘要

参数以 `server/src/agent/toolRegistry.ts` 的注册定义为准；下表只列出使用时最关键的参数，默认值和类型变化时必须先改注册定义、测试和本表。

| 工具 | 必填参数 | 可选参数/筛选 | 备注 |
|---|---|---|---|
| `class_student_count` | 无 | 无 | 使用当前班级/学期上下文 |
| `students_search` | 无 | `keyword`, `limit` | 只返回基础学生信息；学生标识统一返回 `student_id`，兼容旧字段 `id` |
| `students_query` | 无 | `fields`, `keyword`, `gender`, `boarding_status`, `class_role`, `limit` | `fields` 最多 10 个；只返回字段白名单，监护人字段不含电话 |
| `students_aggregate` | `group_by` | `keyword`, `gender`, `boarding_status`, `class_role`, `include_empty`, `include_students`, `limit` | 支持监护人关系/职业等分组；服务端完成统计 |
| `student_get_profile` | `student_id` | 无 | 网页可用；微信默认拒绝敏感档案 |
| `student_get_timeline` | `student_id` | `limit` | 返回事件、沟通和待办摘要 |
| `student_term_comment_context` | `student_ids` | `limit` | 生成评语前读取安全的学期事实摘要；最多 30 人，不含家庭电话、住址和沟通原文 |
| `attendance_summary` | 无 | `student_id`, `date_from`, `date_to`, `limit` | 只读统计 |
| `scores_summary` | 无 | `student_id`, `exam_name`, `limit` | 使用结构化成绩服务 |
| `tasks_list` | 无 | `status`, `student_id`, `limit` | 默认查询未关闭事项 |
| `communications_list` | 无 | `status`, `student_id`, `limit` | 隐藏家长电话 |
| `school_calendar_query` | 无 | `date_from`, `date_to`, `day_type`, `limit` | 使用当前班级/学期校历，不返回学生隐私 |
| `create_task` | `title` | `student_id`, `owner`, `scheduled_at`, `due_at`, `priority`, `notes` | `student_id` 兼容数据库 ID 或学生学号；单条，先预览再确认，执行后验证落库 |
| `record_communication` | `student_id`, `communicated_at`, `method`, `reason`, `summary` | `feedback`, `agreement`, `followup_at`, `status`, `event_id` | 单条，先预览再确认 |
| `save_attendance` | `student_id`, `date`, `status` | `scene`, `reason`, `arrive`, `leave`, `note` | 单条，先预览再确认 |
| `record_points` | `student_id`, `amount`, `reason` | `occurred_at`, `category` | 单条，先预览再确认 |
| `update_task` | `task_id` | `title`, `owner`, `priority`, `scheduled_at`, `due_at`, `status`, `notes`, `result` | 完成/取消状态必须提供 `result`；先预览再确认 |
| `create_event` | `student_id`, `occurred_at`, `event_type`, `description` | `handling`, `parent_contacted`, `needs_followup`, `followup_due`, `status` | `student_id` 兼容数据库 ID 或学生学号；先预览再确认 |
| `create_focus` | `student_id`, `topic`, `reason` | `evidence`, `action_plan`, `status`, `next_review_at` | `student_id` 兼容数据库 ID 或学生学号；先预览再确认 |
| `create_meeting` | `held_on`, `topic` | `format`, `content`, `participation`, `conclusion`, `status`, `student_ids`, `action_items`, `followup_title`, `followup_due` | 学生 ID 或学号；先预览再确认 |
| `create_activity` | `occurred_on`, `name` | `activity_type`, `budget`, `participant_count`, `summary`, `result`, `retrospective`, `status`, `student_ids`, `followup_title`, `followup_due` | 学生 ID 或学号；先预览再确认 |
| `create_diary` | `diary_date` | `weather`, `work`, `event`, `reflection`, `todo` | 先预览再确认 |
| `create_knowledge_note` | `title` | `category`, `template`, `content`, `tags` | 创建本地 Markdown 笔记；先预览再确认 |
| `create_class_task` | `title`, `student_ids` | `task_type`, `start_at`, `due_at`, `material_name`, `description`, `template_id` | 至少一名学生；微信端不可用；先预览再确认 |

## 仍未开放的高风险能力

以下能力只有在完成权限、确认和审计设计后，才能登记为可调用工具：

| 系统能力 | 业务服务 | Agent 工具 | 网页点击 | 网页 Agent | 微信 Agent | 风险/确认 | 状态 |
|---|---|---|---:|---:|---:|---|---|
| 修改学生资料 | 待新增 | 待设计 | 是 | 待确认 | 否 | 敏感写入，必须二次确认 | 未接入 |
| 删除或批量修改数据 | 待新增 | 待设计 | 是 | 否/待评估 | 否 | 高风险写入，默认禁止 | 未接入 |

## 后续评测与预留方向

当前 Harness 已覆盖意图归一化、计划校验、批量查询纠错、权限过滤、确认写入验证和审计。后续工作按以下顺序推进：

- [ ] 记录完整 trace/span，支持按任务回放首个错误步骤。
- [ ] 将线上脱敏 bad case 自动沉淀为固定评测样例。
- [ ] 图片、语音、文件等多模态消息。
- [ ] 多微信账号和多账号会话隔离。
- [ ] 群聊策略和群成员权限。
- [ ] 本地 MCP Server。

新增工具或模型供应商时，先扩展固定回归样例和本矩阵；写入工具继续保持单条、低风险、确认后执行，删除、批量和敏感字段写入不开放。多模态、多账号、群聊和 MCP 不作为当前工作包的隐性范围。

## 新增能力模板

新增能力时复制以下字段，并补齐实现和测试：

```text
系统能力：
业务服务：
Agent 工具：
工具参数：
只读 / 写入：
敏感等级：
网页点击：是 / 否 / 待评估
网页 Agent：是 / 否 / 待评估
微信 Agent：是 / 否 / 待评估
是否需要用户确认：
权限规则：
审计规则：
对应测试：
状态：未接入 / 开发中 / 已接入 / 已停用
```

## 发布检查映射

发布前至少检查四个范围：

1. **系统功能**：页面点击、API、数据库迁移、导入导出；成绩查询需验证网页与 Agent 共用结构化统计口径。
2. **Agent 核心**：规划、工具调用、上下文、权限、错误重试和审计。
3. **网页 Agent**：Markdown 渲染、规划卡片、流式响应和会话清空。
4. **微信 Agent**：凭证、消息收发、会话隔离、敏感权限和断线恢复。
