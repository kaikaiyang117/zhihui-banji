# Agent 能力矩阵

这份矩阵是系统功能、Agent 工具和渠道权限的登记表。

> 当前基线（2026-08-10）：12 个只读工具 + 4 个单条低风险确认写入工具；数据库 schema v24；成绩查询已按四川`3+1+2`合法组合确定适用科目，非法组合不生成完整总分或排名；校历查询已接入网页和微信 Agent。真实学生数据、微信 iLink 断线恢复和移动设备兼容性仍需按发布清单人工验收。

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

## 当前能力

| 系统能力 | 业务服务 | Agent 工具 | 网页点击 | 网页 Agent | 微信 Agent | 风险/确认 | 状态 |
|---|---|---|---:|---:|---:|---|---|
| 查询班级学生总数 | `get_class_student_count` | `class_student_count` | 是 | 是 | 是 | 只读 | 已接入 |
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
| 创建待办 | `work_items.create_work_item` | `create_task` | 是 | 是 | 是 | 低风险写入；预览后必须确认；单条、幂等 | 已接入 |
| 记录家校沟通 | `communications.create_record` | `record_communication` | 是 | 是 | 是 | 写入；预览后必须确认；隐藏敏感联系人字段 | 已接入 |
| 保存单条考勤 | `attendance.save_daily` | `save_attendance` | 是 | 是 | 是 | 低风险写入；预览后必须确认；禁止批量 | 已接入 |
| 记录行为积分 | `points.create_entry` | `record_points` | 是 | 是 | 是 | 低风险写入；预览后必须确认；单条流水可撤销 | 已接入 |

## 工具参数摘要

参数以 `server/src/agent/toolRegistry.ts` 的注册定义为准；下表只列出使用时最关键的参数，默认值和类型变化时必须先改注册定义、测试和本表。

| 工具 | 必填参数 | 可选参数/筛选 | 备注 |
|---|---|---|---|
| `class_student_count` | 无 | 无 | 使用当前班级/学期上下文 |
| `students_search` | 无 | `keyword`, `limit` | 只返回基础学生信息 |
| `students_query` | 无 | `fields`, `keyword`, `gender`, `boarding_status`, `class_role`, `limit` | `fields` 最多 10 个；只返回字段白名单 |
| `students_aggregate` | `group_by` | `keyword`, `gender`, `boarding_status`, `class_role`, `include_empty`, `include_students`, `limit` | 支持 `guardian_occupation` 等分组；服务端完成统计 |
| `student_get_profile` | `student_id` | 无 | 网页可用；微信默认拒绝敏感档案 |
| `student_get_timeline` | `student_id` | `limit` | 返回事件、沟通和待办摘要 |
| `student_term_comment_context` | `student_ids` | `limit` | 生成评语前读取安全的学期事实摘要；最多 30 人，不含家庭电话、住址和沟通原文 |
| `attendance_summary` | 无 | `student_id`, `date_from`, `date_to`, `limit` | 只读统计 |
| `scores_summary` | 无 | `student_id`, `exam_name`, `limit` | 使用结构化成绩服务 |
| `tasks_list` | 无 | `status`, `student_id`, `limit` | 默认查询未关闭事项 |
| `communications_list` | 无 | `status`, `student_id`, `limit` | 隐藏家长电话 |
| `school_calendar_query` | 无 | `date_from`, `date_to`, `day_type`, `limit` | 使用当前班级/学期校历，不返回学生隐私 |
| `create_task` | `title` | `student_id`, `owner`, `scheduled_at`, `due_at`, `priority`, `notes` | 单条，先预览再确认 |
| `record_communication` | `student_id`, `communicated_at`, `method`, `reason`, `summary` | `feedback`, `agreement`, `followup_at`, `status`, `event_id` | 单条，先预览再确认 |
| `save_attendance` | `student_id`, `date`, `status` | `scene`, `reason`, `arrive`, `leave`, `note` | 单条，先预览再确认 |
| `record_points` | `student_id`, `amount`, `reason` | `occurred_at`, `category` | 单条，先预览再确认 |

## 仍未开放的高风险能力

以下能力只有在完成权限、确认和审计设计后，才能登记为可调用工具：

| 系统能力 | 业务服务 | Agent 工具 | 网页点击 | 网页 Agent | 微信 Agent | 风险/确认 | 状态 |
|---|---|---|---:|---:|---:|---|---|
| 修改学生资料 | 待新增 | 待设计 | 是 | 待确认 | 否 | 敏感写入，必须二次确认 | 未接入 |
| 删除或批量修改数据 | 待新增 | 待设计 | 是 | 否/待评估 | 否 | 高风险写入，默认禁止 | 未接入 |

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
