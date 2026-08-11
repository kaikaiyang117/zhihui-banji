/* MIG-11 契约重放：按 03_api_golden.py 的完整用例表（含请求体、捕获键、动态头）
 * 对 Node 服务顺序重放 152 个用例，与 Python 基线（响应规范化后）逐项比较。
 *
 * 运行：npm run test:contract
 * 前置：migrate/baseline/out/api/golden-cases.json（MIG-00 基线脚本生成）。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { setDb } from '../../src/db/index.js';

vi.mock('../../src/agent/runner.js', () => {
  class FakeAgentRunner {
    async chat(_sessionId: string, text: string): Promise<string> {
      return `（黄金基线模拟回答）${String(text ?? '').slice(0, 20)}`;
    }
    async *chatStream(_sessionId: string, text: string): AsyncGenerator<Record<string, string>> {
      yield { type: 'delta', content: `（黄金基线模拟流式回答）${String(text ?? '').slice(0, 20)}` };
    }
  }
  return { AgentRunner: FakeAgentRunner };
});

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
const GOLDEN = path.join(PROJECT_ROOT, 'migrate', 'baseline', 'out', 'api', 'golden-cases.json');
const FIXTURES = path.join(PROJECT_ROOT, 'backend', 'tests', 'fixtures');
const KB_GOLDEN = path.join(PROJECT_ROOT, 'migrate', 'baseline', 'out', 'kb-golden');
const STATIC = path.join(PROJECT_ROOT, 'backend', 'static');

interface GoldenCase {
  id: string;
  expected_status: number;
  response_norm: unknown;
  content_type: string;
}

type CaptureSpec = string | [string, string] | [string, string, 'string'];

interface CaseDef {
  id: string;
  module: string;
  note: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  expect: number;
  headers?: Record<string, string>;
  capture?: CaptureSpec[];
}

/* 与 03_api_golden.py 完全一致的用例表（顺序执行、捕获键联动）。 */
const CASES: CaseDef[] = [
  { id: 'app-01', module: 'app', note: '根页面', method: 'GET', path: '/', expect: 200 },
  { id: 'app-02', module: 'app', note: 'favicon', method: 'GET', path: '/favicon.svg', expect: 200 },
  { id: 'context-01', module: 'context', note: '上下文读取', method: 'GET', path: '/api/context', expect: 200 },
  { id: 'context-02', module: 'context', note: '创建班级（写入）', method: 'POST', path: '/api/classes', body: { name: '黄金测试班', grade: '高一' }, expect: 200, capture: ['class_id', 'term_id'] },
  { id: 'context-03', module: 'context', note: '创建学期（写入）', method: 'POST', path: '/api/classes/{class_id}/terms', body: { name: '黄金学期', start_date: '2026-02-10', end_date: '2026-07-10' }, expect: 200 },
  { id: 'context-04', module: 'context', note: '空班级名错误', method: 'POST', path: '/api/classes', body: { name: '', grade: '' }, expect: 422 },
  { id: 'context-05', module: 'context', note: '在班关系读取', method: 'GET', path: '/api/enrollments', expect: 200 },
  { id: 'context-06', module: 'context', note: '在班关系写入', method: 'POST', path: '/api/enrollments', body: { student_id: 1, status: '在读' }, expect: 200 },
  { id: 'context-07', module: 'context', note: '归档班级（供权限用例）', method: 'POST', path: '/api/classes', body: { name: '归档班', grade: '' }, expect: 200, capture: [['archived_class_id', 'class_id'], ['archived_term_default', 'term_id']] },
  { id: 'context-08', module: 'context', note: '归档黄金测试班学期（写入）', method: 'PUT', path: '/api/terms/{term_id}', body: { status: '已归档' }, expect: 200 },
  { id: 'context-08a0', module: 'context', note: '归档班默认学期归档（写入）', method: 'PUT', path: '/api/terms/{archived_term_default}', body: { status: '已归档' }, expect: 200 },
  { id: 'context-08a', module: 'context', note: '归档班再建学期', method: 'POST', path: '/api/classes/{archived_class_id}/terms', body: { name: '归档班学期' }, expect: 200, capture: [['archived_term_id', 'term_id']] },
  { id: 'context-08b', module: 'context', note: '归档班学期归档（写入）', method: 'PUT', path: '/api/terms/{archived_term_id}', body: { status: '已归档' }, expect: 200 },
  { id: 'context-08c', module: 'context', note: '归档班级（写入）', method: 'PUT', path: '/api/classes/{archived_class_id}', body: { status: '已归档' }, expect: 200 },
  { id: 'context-09', module: 'context', note: '归档班级读取放行（只读语义）', method: 'GET', path: '/api/students', headers: { 'x-workbench-class': '{archived_class_id}', 'x-workbench-term': '{archived_term_id}' }, expect: 200 },
  { id: 'context-10', module: 'context', note: '归档班级写入拒绝（409）', method: 'POST', path: '/api/events', headers: { 'x-workbench-class': '{archived_class_id}', 'x-workbench-term': '{archived_term_id}' }, body: { student_id: 1, occurred_at: '2026-04-15 08:10', event_type: '迟到', description: '归档写入测试' }, expect: 409 },
  { id: 'students-01', module: 'students', note: '学生列表读取', method: 'GET', path: '/api/students', expect: 200 },
  { id: 'students-02', module: 'students', note: '新增学生（写入）', method: 'POST', path: '/api/students', body: { 学号: 'G001', 姓名: '黄金学生', 性别: '男' }, expect: 200, capture: ['student_id'] },
  { id: 'students-03', module: 'students', note: '更新学生（写入）', method: 'PUT', path: '/api/students/{student_id}', body: { 姓名: '黄金学生二号' }, expect: 200 },
  { id: 'students-04', module: 'students', note: '重复学号错误', method: 'POST', path: '/api/students', body: { 学号: 'G001', 姓名: '重复学生' }, expect: 409 },
  { id: 'students-05', module: 'students', note: '头像不存在（错误）', method: 'GET', path: '/api/students/{student_id}/photo', expect: 404 },
  { id: 'students-06', module: 'students', note: '导入模板（二进制）', method: 'GET', path: '/api/students/template', expect: 200 },
  { id: 'students-07', module: 'students', note: '导出学生（二进制）', method: 'GET', path: '/api/students/export', expect: 200 },
  { id: 'sheets-01', module: 'sheets', note: '工作表元数据列表', method: 'GET', path: '/api/sheets', expect: 200 },
  { id: 'sheets-02', module: 'sheets', note: '追加行（写入）', method: 'POST', path: '/api/sheet/班主任日志/append', body: { data: [{ 日期: '2026-04-15', 内容: '黄金基线记录' }] }, expect: 200, capture: ['row_no'] },
  { id: 'sheets-03', module: 'sheets', note: '更新行（写入）', method: 'PUT', path: '/api/sheet/班主任日志/update', body: { row_no: '{row_no}', col: 1, value: '黄金基线记录已更新' }, expect: 200 },
  { id: 'sheets-04', module: 'sheets', note: '更新不存在行（错误）', method: 'PUT', path: '/api/sheet/班主任日志/update', body: { row_no: 9999, col: 0, value: 'x' }, expect: 404 },
  { id: 'sheets-05', module: 'sheets', note: '行数据读取', method: 'GET', path: '/api/sheet/班主任日志', expect: 200 },
  { id: 'seating-01', module: 'seating', note: '座位表读取', method: 'GET', path: '/api/seating', expect: 200 },
  { id: 'seating-02', module: 'seating', note: '座位更新（写入）', method: 'POST', path: '/api/seating/update', body: { row: 1, col: 1, value: '张同学' }, expect: 200 },
  { id: 'stats-01', module: 'stats', note: '首页统计读取', method: 'GET', path: '/api/stats/dashboard', expect: 200 },
  { id: 'stats-02', module: 'stats', note: '本月日历读取', method: 'GET', path: '/api/stats/calendar', expect: 200 },
  { id: 'stats-03', module: 'stats', note: '考勤统计读取', method: 'GET', path: '/api/stats/attendance', expect: 200 },
  { id: 'stats-04', module: 'stats', note: '成绩统计读取', method: 'GET', path: '/api/stats/scores', expect: 200 },
  { id: 'stats-05', module: 'stats', note: '积分统计读取', method: 'GET', path: '/api/stats/points', expect: 200 },
  { id: 'stats-06', module: 'stats', note: '班费统计读取', method: 'GET', path: '/api/stats/fund', expect: 200 },
  { id: 'p0-01', module: 'p0', note: '工作项列表读取', method: 'GET', path: '/api/tasks', expect: 200 },
  { id: 'p0-02', module: 'p0', note: '创建事件（写入）', method: 'POST', path: '/api/events', body: { student_id: 1, occurred_at: '2026-04-15 08:10', event_type: '迟到', description: '黄金基线事件', needs_followup: true, followup_due: '2026-04-18' }, expect: 200, capture: ['event_id'] },
  { id: 'p0-03', module: 'p0', note: '学生详情读取', method: 'GET', path: '/api/students/{student_id}/detail', expect: 200 },
  { id: 'p0-04', module: 'p0', note: '家校沟通写入', method: 'POST', path: '/api/communications', body: { student_id: 1, communicated_at: '2026-04-15 09:00', method: '电话', reason: '迟到沟通', summary: '已提醒按时到校' }, expect: 200 },
  { id: 'p0-05', module: 'p0', note: '创建任务（写入）', method: 'POST', path: '/api/tasks', body: { title: '黄金基线任务', student_id: 1, due_at: '2026-04-18' }, expect: 200, capture: ['task_id'] },
  { id: 'p0-06', module: 'p0', note: '完成任务（写入）', method: 'PUT', path: '/api/tasks/{task_id}', body: { status: '已完成', result: '黄金基线完成' }, expect: 200 },
  { id: 'p0-07', module: 'p0', note: '不存在学生的事件（错误）', method: 'POST', path: '/api/events', body: { student_id: 9999, occurred_at: '2026-04-15 08:10', event_type: '迟到', description: 'x' }, expect: 404 },
  { id: 'p0-08', module: 'p0', note: '批量考勤写入', method: 'POST', path: '/api/attendance/daily', body: { date: '2026-04-15', scene: '常规到校', records: [{ student_id: 1, status: '出勤' }] }, expect: 200 },
  { id: 'p0-09', module: 'p0', note: '工作项汇总读取', method: 'GET', path: '/api/tasks/summary', expect: 200 },
  { id: 'p0-10', module: 'p0', note: '考勤记录读取', method: 'GET', path: '/api/attendance/records', expect: 200 },
  { id: 'p1-01', module: 'p1', note: '搜索读取', method: 'GET', path: '/api/search', query: { q: '张三' }, expect: 200 },
  { id: 'p1-02', module: 'p1', note: '科目配置写入', method: 'POST', path: '/api/score-config/subjects', body: { name: '物理', full_score: 100, type: '选考' }, expect: 200, capture: ['subject_id'] },
  { id: 'p1-03', module: 'p1', note: '考试配置写入', method: 'POST', path: '/api/score-config/exams', body: { name: '黄金月考', exam_date: '2026-04-20' }, expect: 200, capture: [['exam_id', 'id'], ['exam_id', 'exam_id']] },
  { id: 'p1-04', module: 'p1', note: '考试配置更新', method: 'PUT', path: '/api/score-config/exams/{exam_id}', body: { name: '黄金月考（更新）' }, expect: 200 },
  { id: 'p1-05', module: 'p1', note: '成绩导入提交（写入）', method: 'POST', path: '/api/exams/import/commit', body: { filename: 'golden.xlsx', request_id: 'golden-exam-commit', rows: [{ row: 1, valid: true, student_id: 1, exam_name: '黄金月考', exam_date: '2026-04-20', subject: '物理', score: 92.0, rank: 1, record_status: '正常', note: '' }] }, expect: 200 },
  { id: 'p1-06', module: 'p1', note: '成绩记录读取', method: 'GET', path: '/api/exams', expect: 200 },
  { id: 'p1-07', module: 'p1', note: '成绩汇总读取', method: 'GET', path: '/api/exams/summary', expect: 200 },
  { id: 'p1-08', module: 'p1', note: '考勤规则写入', method: 'POST', path: '/api/attendance/rules', body: { name: '黄金考勤规则', metric: '迟到次数', threshold: 3, period_days: 7, scene: '早自习', enabled: true }, expect: 200, capture: [['attendance_rule_id', 'rule_id'], ['attendance_rule_id', 'id']] },
  { id: 'p1-09', module: 'p1', note: '考勤规则更新', method: 'PUT', path: '/api/attendance/rules/{attendance_rule_id}', body: { enabled: false }, expect: 200 },
  { id: 'p1-10', module: 'p1', note: '考勤规则评估（写入）', method: 'POST', path: '/api/attendance/rules/evaluate', body: { reference_date: '2026-04-15' }, expect: 200 },
  { id: 'p1-11', module: 'p1', note: '考勤规则读取', method: 'GET', path: '/api/attendance/rules', expect: 200 },
  { id: 'p1-12', module: 'p1', note: '任务模板写入', method: 'POST', path: '/api/class-task-templates', body: { name: '黄金任务模板', material_name: '作业本', description: '收集材料' }, expect: 200, capture: [['template_id', 'id'], ['template_id', 'template_id']] },
  { id: 'p1-13', module: 'p1', note: '任务模板更新', method: 'PUT', path: '/api/class-task-templates/{template_id}', body: { content: '收集材料（更新）' }, expect: 200 },
  { id: 'p1-14', module: 'p1', note: '班级任务写入', method: 'POST', path: '/api/class-tasks', body: { title: '黄金班级任务', description: '收集材料', material_name: '作业本', student_ids: [1] }, expect: 200, capture: [['class_task_id', 'task_id']] },
  { id: 'p1-15', module: 'p1', note: '任务提交（写入）', method: 'PUT', path: '/api/class-tasks/{class_task_id}/items/1', body: { status: '已提交', note: '黄金基线' }, expect: 200 },
  { id: 'p1-16', module: 'p1', note: '班级任务读取', method: 'GET', path: '/api/class-tasks', expect: 200 },
  { id: 'p1-17', module: 'p1', note: '值日读取', method: 'GET', path: '/api/duty', expect: 200 },
  { id: 'p1-18', module: 'p1', note: '值日写入', method: 'POST', path: '/api/duty', body: { duty_date: '2026-04-15', area: '教室', student_id: 1 }, expect: 200 },
  { id: 'p1-19', module: 'p1', note: '值日轮换规则写入', method: 'POST', path: '/api/duty/rotation-rules', body: { name: '黄金轮换', area: '教室', start_date: '2026-03-01', period_days: 7, student_ids: [1] }, expect: 200, capture: [['rotation_rule_id', 'rule_id'], ['rotation_rule_id', 'id']] },
  { id: 'p1-20', module: 'p1', note: '轮换生成（写入）', method: 'POST', path: '/api/duty/rotation-rules/{rotation_rule_id}/generate', body: {}, expect: 200 },
  { id: 'p1-21', module: 'p1', note: '成绩配置读取', method: 'GET', path: '/api/score-config', expect: 200 },
  { id: 'p1-22', module: 'p1', note: '成绩导入缺字段（错误）', method: 'POST', path: '/api/exams/import/commit', body: { filename: 'bad.xlsx', request_id: 'golden-bad', rows: [{ row: 1, valid: false, student_id: 1, exam_name: '', subject: '', score: null, rank: null, record_status: '错误', note: '缺科目' }] }, expect: 400 },
  { id: 'points-01', module: 'points', note: '积分流水读取', method: 'GET', path: '/api/points', expect: 200 },
  { id: 'points-02', module: 'points', note: '积分流水写入', method: 'POST', path: '/api/points/entries', body: { student_id: 1, amount: 5, reason: '黄金基线加分' }, expect: 200, capture: [['point_entry_id', 'id']] },
  { id: 'points-03', module: 'points', note: '积分撤销（写入）', method: 'POST', path: '/api/points/entries/{point_entry_id}/revoke', body: { reason: '黄金基线撤销' }, expect: 200 },
  { id: 'points-04', module: 'points', note: '积分规则写入', method: 'POST', path: '/api/points/rules', body: { name: '黄金积分规则', category: '日常行为', metric: '周期扣分', threshold: 3, period_days: 7 }, expect: 200, capture: ['point_rule_id'] },
  { id: 'points-05', module: 'points', note: '积分规则评估（写入）', method: 'POST', path: '/api/points/rules/evaluate', body: { reference_date: '2026-04-15' }, expect: 200 },
  { id: 'points-06', module: 'points', note: '不存在学生积分（错误）', method: 'POST', path: '/api/points/entries', body: { student_id: 9999, amount: 1, reason: 'x' }, expect: 404 },
  { id: 'points-07', module: 'points', note: '规则命中读取', method: 'GET', path: '/api/points/rule-hits', expect: 200 },
  { id: 'funds-01', module: 'funds', note: '班费流水读取', method: 'GET', path: '/api/fund', expect: 200 },
  { id: 'funds-02', module: 'funds', note: '班费流水写入', method: 'POST', path: '/api/fund/entries', body: { direction: '支出', amount: 50.0, description: '黄金基线支出' }, expect: 200, capture: [['fund_entry_id', 'id']] },
  { id: 'funds-03', module: 'funds', note: '班费流水更新', method: 'PUT', path: '/api/fund/entries/{fund_entry_id}', body: { description: '黄金基线支出（更新）' }, expect: 200 },
  { id: 'funds-04', module: 'funds', note: '未结算流水不可冲正（业务规则，400）', method: 'POST', path: '/api/fund/entries/{fund_entry_id}/reverse', body: { reason: '黄金基线冲正', occurred_at: '2026-04-15' }, expect: 400 },
  { id: 'funds-05', module: 'funds', note: '班费流水撤销（写入）', method: 'POST', path: '/api/fund/entries/{fund_entry_id}/revoke', body: { reason: '黄金基线撤销' }, expect: 200 },
  { id: 'funds-06', module: 'funds', note: '班费分类写入', method: 'POST', path: '/api/fund/categories', body: { name: '图书费', direction: '支出' }, expect: 200 },
  { id: 'funds-07', module: 'funds', note: '班费分类读取', method: 'GET', path: '/api/fund/categories', expect: 200 },
  { id: 'funds-08', module: 'funds', note: '班费结算写入', method: 'POST', path: '/api/fund/settlements', body: { period_start: '2026-03-01', period_end: '2026-03-31' }, expect: 200 },
  { id: 'funds-09', module: 'funds', note: '班费缺金额（错误）', method: 'POST', path: '/api/fund/entries', body: { direction: '支出', description: 'x' }, expect: 422 },
  { id: 'comments-01', module: 'comments', note: '评语读取', method: 'GET', path: '/api/comments', expect: 200 },
  { id: 'comments-02', module: 'comments', note: '评语模板写入', method: 'POST', path: '/api/comments/templates', body: { name: '黄金模板', comment_type: '学期评语', content: '表现良好' }, expect: 200, capture: [['comment_template_id', 'id']] },
  { id: 'comments-03', module: 'comments', note: '评语模板更新', method: 'PUT', path: '/api/comments/templates/{comment_template_id}', body: { content: '表现优秀' }, expect: 200 },
  { id: 'comments-04', module: 'comments', note: '评语条目写入', method: 'POST', path: '/api/comments/entries', body: { student_id: 1, comment_type: '学期评语', content: '黄金基线评语' }, expect: 200, capture: [['comment_entry_id', 'id']] },
  { id: 'comments-05', module: 'comments', note: '评语条目更新', method: 'PUT', path: '/api/comments/entries/{comment_entry_id}', body: { content: '黄金基线评语（更新）' }, expect: 200 },
  { id: 'comments-06', module: 'comments', note: '评语流转到待审核（写入）', method: 'POST', path: '/api/comments/entries/{comment_entry_id}/transition', body: { target_status: '待审核', note: '提交审核' }, expect: 200 },
  { id: 'comments-07', module: 'comments', note: '评语流转到完成（写入）', method: 'POST', path: '/api/comments/entries/{comment_entry_id}/transition', body: { target_status: '完成', note: '审核通过' }, expect: 200 },
  { id: 'comments-08', module: 'comments', note: '评语空内容（错误）', method: 'POST', path: '/api/comments/entries', body: { student_id: 1, content: '' }, expect: 422 },
  { id: 'education-01', module: 'education', note: '班会列表读取', method: 'GET', path: '/api/education/meetings', expect: 200 },
  { id: 'education-02', module: 'education', note: '班会写入', method: 'POST', path: '/api/education/meetings', body: { topic: '黄金基线班会', held_on: '2026-04-15', content: '纪律要求' }, expect: 200, capture: [['meeting_id', 'id'], ['meeting_id', 'meeting_id']] },
  { id: 'education-03', module: 'education', note: '班会更新', method: 'PUT', path: '/api/education/meetings/{meeting_id}', body: { content: '纪律要求（更新）' }, expect: 200 },
  { id: 'education-04', module: 'education', note: '日志写入', method: 'POST', path: '/api/education/diary', body: { diary_date: '2026-04-15', work: '黄金基线日志' }, expect: 200, capture: [['diary_id', 'id'], ['diary_id', 'diary_id']] },
  { id: 'education-05', module: 'education', note: '日志更新', method: 'PUT', path: '/api/education/diary/{diary_id}', body: { content: '黄金基线日志（更新）' }, expect: 200 },
  { id: 'education-06', module: 'education', note: '活动写入', method: 'POST', path: '/api/education/activities', body: { name: '黄金基线活动', occurred_on: '2026-04-15', summary: '春游' }, expect: 200, capture: [['activity_id', 'id'], ['activity_id', 'activity_id']] },
  { id: 'education-07', module: 'education', note: '活动读取', method: 'GET', path: '/api/education/activities/{activity_id}', expect: 200 },
  { id: 'education-08', module: 'education', note: '删除不存在日志（旧行为缺陷 500）', method: 'DELETE', path: '/api/education/diary/9999', expect: 500 },
  { id: 'education-09', module: 'education', note: '班会模板写入', method: 'POST', path: '/api/education/templates', body: { kind: 'meeting', name: '黄金班会模板', content: '流程模板' }, expect: 200 },
  { id: 'reports-01', module: 'reports', note: '报告档案读取', method: 'GET', path: '/api/reports/archives', expect: 200 },
  { id: 'reports-02', module: 'reports', note: '报告预览（写入）', method: 'POST', path: '/api/reports/preview', body: { report_type: 'weekly', period_start: '2026-04-06', period_end: '2026-04-12' }, expect: 200 },
  { id: 'reports-03', module: 'reports', note: '报告归档（写入）', method: 'POST', path: '/api/reports/archives', body: { report_type: 'weekly', period_start: '2026-04-06', period_end: '2026-04-12', class_summary: '本周整体稳定' }, expect: 200, capture: [['archive_id', 'id'], ['archive_id', 'archive_id']] },
  { id: 'reports-04', module: 'reports', note: '报告档案读取', method: 'GET', path: '/api/reports/archives/{archive_id}', expect: 200 },
  { id: 'reports-05', module: 'reports', note: '报告导出（二进制）', method: 'GET', path: '/api/reports/archives/{archive_id}/export', expect: 200 },
  { id: 'health-01', module: 'health', note: '健康汇总读取', method: 'GET', path: '/api/health/summary', expect: 200 },
  { id: 'health-02', module: 'health', note: '健康目标写入', method: 'POST', path: '/api/health/goals', body: { metric: '体重', target_value: 60.0, unit: 'kg' }, expect: 200, capture: [['goal_id', 'id'], ['goal_id', 'goal_id']] },
  { id: 'health-03', module: 'health', note: '健康目标更新', method: 'PUT', path: '/api/health/goals/{goal_id}', body: { target_value: 58.0 }, expect: 200 },
  { id: 'health-04', module: 'health', note: '健康提醒写入', method: 'POST', path: '/api/health/reminders', body: { reminder_type: 'sleep', enabled: true, remind_time: '22:30' }, expect: 200 },
  { id: 'health-05', module: 'health', note: '健康提醒读取', method: 'GET', path: '/api/health/reminders', expect: 200 },
  { id: 'health-06', module: 'health', note: '健康复盘写入', method: 'POST', path: '/api/health/reviews', body: { period_type: 'month', summary: '本月保持' }, expect: 200 },
  { id: 'health-07', module: 'health', note: '健康目标读取', method: 'GET', path: '/api/health/goals', expect: 200 },
  { id: 'knowledge-01', module: 'knowledge', note: '笔记列表读取', method: 'GET', path: '/api/knowledge/notes', expect: 200 },
  { id: 'knowledge-02', module: 'knowledge', note: '创建笔记（写入）', method: 'POST', path: '/api/knowledge/create', body: { title: '黄金基线笔记', category: '个人成长', content: '## 标题\n正文内容', tags: ['黄金'] }, expect: 200, capture: [['note_id', 'id']] },
  { id: 'knowledge-03', module: 'knowledge', note: '笔记内容读取', method: 'GET', path: '/api/knowledge/notes/read', query: { path: '个人成长/黄金基线笔记.md' }, expect: 200 },
  { id: 'knowledge-04', module: 'knowledge', note: '更新笔记（写入）', method: 'PUT', path: '/api/knowledge/notes/{note_id}', body: { title: '黄金基线笔记（更新）', content: '更新后的内容' }, expect: 200 },
  { id: 'knowledge-05', module: 'knowledge', note: '更新不存在笔记（错误）', method: 'PUT', path: '/api/knowledge/notes/9999', body: { title: 'x', content: 'y' }, expect: 400 },
  { id: 'knowledge-06', module: 'knowledge', note: '外部冲突读取', method: 'GET', path: '/api/knowledge/notes', query: { q: '黄金' }, expect: 200 },
  { id: 'export-01', module: 'export', note: '工作表导出（二进制）', method: 'GET', path: '/api/export/sheet/学生信息总表', expect: 200 },
  { id: 'export-02', module: 'export', note: '考勤汇总导出（二进制）', method: 'GET', path: '/api/export/report/attendance', query: { date_from: '2026-04-01', date_to: '2026-04-30' }, expect: 200 },
  { id: 'recycle-01', module: 'recycle', note: '回收站读取', method: 'GET', path: '/api/recycle-bin', expect: 200 },
  { id: 'recycle-02', module: 'recycle', note: '事件移入回收站（写入）', method: 'DELETE', path: '/api/records/event/{event_id}', expect: 200 },
  { id: 'recycle-03', module: 'recycle', note: '回收站含软删记录', method: 'GET', path: '/api/recycle-bin', expect: 200 },
  { id: 'recycle-04', module: 'recycle', note: '系统审计读取', method: 'GET', path: '/api/system/audit', expect: 200 },
  { id: 'recycle-05', module: 'recycle', note: '恢复不存在记录（错误）', method: 'POST', path: '/api/recycle-bin/9999/restore', expect: 400 },
  { id: 'recycle-06', module: 'recycle', note: '永久删除不存在记录（错误）', method: 'DELETE', path: '/api/recycle-bin/9999/purge', body: { confirmation: '永久删除' }, expect: 400 },
  { id: 'workflow-00', module: 'p0', note: '为工作流用例新建事件', method: 'POST', path: '/api/events', body: { student_id: 1, occurred_at: '2026-04-16 08:10', event_type: '迟到', description: '黄金基线事件二号' }, expect: 200, capture: [['workflow_event_id', 'event_id']] },
  { id: 'workflow-01', module: 'workflow', note: '工作流来源读取', method: 'GET', path: '/api/workflows/event/{workflow_event_id}', expect: 200 },
  { id: 'workflow-02', module: 'workflow', note: '工作流更新（写入）', method: 'PUT', path: '/api/workflows/event/{workflow_event_id}', body: { status: '已完成', result: '黄金基线处理完毕', request_id: 'golden-workflow' }, expect: 200 },
  { id: 'workflow-03', module: 'workflow', note: '工作流不存在来源（错误）', method: 'PUT', path: '/api/workflows/event/9999', body: { status: '已完成' }, expect: 404 },
  { id: 'system-01', module: 'system', note: '健康检查', method: 'GET', path: '/api/system/health', expect: 200 },
  { id: 'system-02', module: 'system', note: '运行时信息', method: 'GET', path: '/api/system/runtime', expect: 200 },
  { id: 'system-03', module: 'system', note: '局域网访问信息', method: 'GET', path: '/api/system/access-info', expect: 200 },
  { id: 'system-04', module: 'system', note: '备份列表读取', method: 'GET', path: '/api/system/backups', expect: 200 },
  { id: 'system-05', module: 'system', note: '创建备份（写入）', method: 'POST', path: '/api/system/backup', expect: 200, capture: [['backup_filename', 'filename', 'string']] },
  { id: 'system-06', module: 'system', note: '下载备份（二进制）', method: 'GET', path: '/api/system/backup/{backup_filename}', expect: 200 },
  { id: 'system-07', module: 'system', note: '更新 Token 状态读取', method: 'GET', path: '/api/system/update/github-token', expect: 200 },
  { id: 'system-08', module: 'system', note: '保存 Token（写入）', method: 'PUT', path: '/api/system/update/github-token', body: { token: 'ghp_goldenbaselinetoken123456789' }, expect: 200 },
  { id: 'system-09', module: 'system', note: '非法 Token（错误）', method: 'PUT', path: '/api/system/update/github-token', body: { token: 'not-a-token' }, expect: 400 },
  { id: 'system-10', module: 'system', note: '更新状态读取', method: 'GET', path: '/api/system/update/status', expect: 200 },
  { id: 'agent-01', module: 'agent', note: 'Agent 状态读取', method: 'GET', path: '/api/agent/status', expect: 200 },
  { id: 'agent-02', module: 'agent', note: '工具列表读取', method: 'GET', path: '/api/agent/tools', expect: 200 },
  { id: 'agent-03', module: 'agent', note: '只读工具调用', method: 'POST', path: '/api/agent/tools/students_query', body: { arguments: { fields: ['student_no', 'student_name'] }, channel: 'web', actor_id: 'golden' }, expect: 200 },
  { id: 'agent-04', module: 'agent', note: '不存在工具（错误）', method: 'POST', path: '/api/agent/tools/nonexistent_tool', body: { arguments: {}, channel: 'web', actor_id: 'golden' }, expect: 400 },
  { id: 'agent-05', module: 'agent', note: '网页对话（写入，模拟模型）', method: 'POST', path: '/api/agent/chat', body: { session_id: 'golden-web-session', message: '查看所有学生的姓名', channel: 'web', actor_id: 'golden-user' }, expect: 200 },
  { id: 'agent-06', module: 'agent', note: '会话列表读取', method: 'GET', path: '/api/agent/sessions', expect: 200 },
  { id: 'agent-07', module: 'agent', note: '空消息（错误）', method: 'POST', path: '/api/agent/chat', body: { session_id: 'golden-web-session', message: '' }, expect: 422 },
  { id: 'agent-08', module: 'agent', note: '流式对话（模拟模型）', method: 'POST', path: '/api/agent/chat/stream', body: { session_id: 'golden-web-session', message: '查看所有学生的姓名', channel: 'web', actor_id: 'golden-user' }, expect: 200 },
  { id: 'wechat-01', module: 'wechat', note: '微信配置读取', method: 'GET', path: '/api/wechat/config', expect: 200 },
  { id: 'wechat-02', module: 'wechat', note: '微信状态读取', method: 'GET', path: '/api/wechat/status', expect: 200 },
  { id: 'wechat-03', module: 'wechat', note: '空配置保存（旧行为接受）', method: 'PUT', path: '/api/wechat/config', body: { base_url: '', client_id: '', client_secret: '' }, expect: 200 },
];

const TIMESTAMP_KEYS = new Set([
  'created_at', 'updated_at', 'applied_at', 'occurred_at', 'archived_at', 'joined_at',
  'submitted_at', 'completed_at', 'communicated_at', 'modified', 'revoked_at',
  'reconciled_at', 'review_at', 'remind_at', 'started_at', 'last_access_at',
  'expires_at', 'audit_time', 'last_run_at', 'reversed_at', 'settled_at', 'edited_at',
  'reviewed_at', 'deleted_at', 'closed_at', 'sent_at', 'next_action_at', 'due_at',
  'scheduled_at', 'followup_due', 'end_date', 'start_date', 'exam_date', 'diary_date',
  'duty_date', 'calendar_date', 'occurred_on', 'held_on', 'log_date', 'activity_date',
  'today', 'reference_date',
]);
const ID_KEYS = new Set([
  'id', 'entry_id', 'rule_id', 'goal_id', 'reminder_id', 'template_id', 'category_id',
  'settlement_id', 'archive_id', 'attachment_id', 'note_id', 'task_id', 'event_id',
  'focus_id', 'communication_id', 'comment_id', 'meeting_id', 'diary_id', 'activity_id',
  'class_id', 'term_id', 'enrollment_id', 'student_id', 'exam_id', 'subject_id',
  'assignment_id', 'device_id', 'action_id', 'config_id', 'version_id', 'source_id',
  'rollover_id', 'plan_id', 'result_id',
]);
const TS_PATTERN = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalize(payload: unknown, key = ''): unknown {
  if (Array.isArray(payload)) return payload.map(item => normalize(item, key));
  if (payload && typeof payload === 'object') {
    const result: Record<string, unknown> = {};
    for (const [innerKey, value] of Object.entries(payload as Record<string, unknown>)) {
      if (ID_KEYS.has(innerKey) || innerKey === 'id') result[innerKey] = `<${innerKey}>`;
      else if (TIMESTAMP_KEYS.has(innerKey)) result[innerKey] = '<ts>';
      else result[innerKey] = normalize(value, innerKey);
    }
    return result;
  }
  if (typeof payload === 'string') {
    const value = payload;
    if (key === 'filename' && value.startsWith('workbench-')) return '<backup-name>';
    if (value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) {
      try {
        return canonical(normalize(JSON.parse(value)));
      } catch {
        // 不是 JSON 字符串，继续
      }
    }
    if (TS_PATTERN.test(value)) return value.replace(TS_PATTERN, '<ts>');
    if (key === 'file_mtime' || (key === 'size' && /^\d+$/.test(value))) return '<dynamic>';
    if (DATE_ONLY_PATTERN.test(value) && TIMESTAMP_KEYS.has(key)) return '<ts>';
    return value;
  }
  if (typeof payload === 'number') {
    if (key === 'file_mtime') return '<mtime>';
    if (key === 'size') return '<size>';
    return payload;
  }
  return payload;
}

/** 与 Python json.dumps(..., ensure_ascii=False, sort_keys=True) 对齐的稳定序列化。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return JSON.stringify(value);
}

function findValue(raw: unknown, key: string): unknown {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = findValue(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (key in record) return record[key];
    for (const value of Object.values(record)) {
      const found = findValue(value, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function substitute(value: string, ctx: Record<string, string>): string {
  return value.replace(/\{([a-z_]+)\}/g, (_match, name) => ctx[name] ?? `{${name}}`);
}

describe('契约重放（golden-cases 全量）', () => {
  it('golden-cases.json 与用例表一致（152 条）', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf-8')) as { cases: GoldenCase[] };
    expect(golden.cases).toHaveLength(CASES.length);
    for (let index = 0; index < CASES.length; index += 1) {
      expect(golden.cases[index].id, `第 ${index} 条顺序`).toBe(CASES[index].id);
    }
  });

  it('重放全部用例：状态与规范化内容逐项比较', async () => {
    const previous = { ...process.env };
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mig11-contract-'));
    /* 与基线脚本一致的环境：业务日期 2026-04-15、微信凭据（基线运行时来自环境）、
     * 不设置 WORKBENCH_VERSION（回退到 app-version.json → 0.0.0-dev）。 */
    process.env.WORKBENCH_DATA_DIR = tempDir;
    process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
    process.env.WORKBENCH_STATIC_DIR = STATIC;
    process.env.WORKBENCH_LOG_LEVEL = 'silent';
    process.env.MEIMEI_WECHAT_BOT_TOKEN = 'golden-bot-token';
    process.env.MEIMEI_WECHAT_ACCOUNT_ID = '62c9e87c0a5b@im.bot';
    process.env.MEIMEI_WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
    process.env.MEIMEI_MODEL_NAME = 'deepseek-v4-flash';
    process.env.MEIMEI_MODEL_API_KEY = 'sk-golden-baseline';
    process.env.MEIMEI_MODEL_BASE_URL = 'https://api.deepseek.com/v1';
    const kbDir = path.join(tempDir, 'kb-golden');
    if (fs.existsSync(KB_GOLDEN)) fs.cpSync(KB_GOLDEN, kbDir, { recursive: true });
    process.env.WORKBENCH_KB_DIR = kbDir;
    const config = loadConfig();

    const db = new WorkbenchDb({ dataDir: tempDir });
    db.open();
    setDatabase(db);
    setDb(db);
    const conn = db.connInstance;
    const studentsSeen = new Set<string>();
    for (const fixtureName of ['p0_demo.json', 'p1_demo.json']) {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, fixtureName), 'utf-8')) as {
        students?: Array<Record<string, string>>;
      };
      for (const student of fixture.students ?? []) {
        const no = student['学号'] ?? '';
        if (!no || studentsSeen.has(no)) continue;
        studentsSeen.add(no);
        conn.prepare('INSERT INTO students(学号, 姓名, 性别, 班级任职) VALUES(?,?,?,?)')
          .run(student['学号'] ?? '', student['姓名'] ?? '', student['性别'] ?? '', student['班级任职'] ?? '');
      }
    }
    conn.prepare(
      `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status, joined_at)
       SELECT id, 1, 1, '在读', date('now','localtime') FROM students`,
    ).run();

    const app = buildApp({ config });
    await app.ready();

    const goldenMap = new Map<string, GoldenCase>();
    for (const c of (JSON.parse(fs.readFileSync(GOLDEN, 'utf-8')) as { cases: GoldenCase[] }).cases) {
      goldenMap.set(c.id, c);
    }

    const ctx: Record<string, string> = { student_id: '1' };
    const diffs: string[] = [];
    let matched = 0;
    let binaryUnverified = 0;

    for (const def of CASES) {
      const golden = goldenMap.get(def.id);
      const url = substitute(def.path, ctx);
      let body = def.body;
      if (typeof body === 'object' && body !== null) {
        body = JSON.parse(JSON.stringify(def.body, (_key, value) => (
          typeof value === 'string' ? substitute(value, ctx) : value
        ))) as unknown;
      }
      const headers: Record<string, string> = {
        'x-workbench-class': '1',
        'x-workbench-term': '1',
        ...Object.fromEntries(
          Object.entries(def.headers ?? {}).map(([k, v]) => [k, substitute(v, ctx)]),
        ),
      };
      const response = await app.inject({ method: def.method, url, query: def.query ?? {}, payload: body, headers });
      const raw = response.body;
      const contentType = String(response.headers['content-type'] ?? '');
      const statusOk = response.statusCode === def.expect;

      if (def.capture && response.statusCode === def.expect) {
        for (const spec of def.capture) {
          const [target, source, mode] = typeof spec === 'string'
            ? [spec, spec, 'digit']
            : (spec as [string, string, 'string'?]);
          const value = findValue(response.json(), source);
          if ((typeof value === 'number') || (typeof value === 'string' && (mode === 'string' || /^\d+$/.test(value)))) {
            ctx[target] = String(value);
          }
        }
      }

      let contentOk = true;
      let verified = true;
      if (contentType.includes('application/json')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw as string);
        } catch {
          parsed = raw;
        }
        const expected = golden?.response_norm;
        if (expected === null || expected === undefined) {
          contentOk = false;
        } else {
          contentOk = canonical(normalize(parsed)) === canonical(normalize(expected));
        }
      } else if (golden?.response_norm && typeof golden.response_norm === 'object') {
        /* 二进制/HTML：只比较 content_type；sha256 允许差异（导出/前端产物逐字节不同）。 */
        contentOk = (golden.response_norm as Record<string, unknown>).content_type === contentType;
        verified = false;
      }

      let detail = '';
      if (!contentOk && contentType.includes('application/json') && golden) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw as string);
        } catch {
          parsed = raw;
        }
        detail = `\n  期望=${canonical(normalize(golden.response_norm))}\n  实际=${canonical(normalize(parsed))}`;
      }
      if (statusOk && contentOk) {
        matched += 1;
      } else {
        if (!verified) binaryUnverified += 1;
        diffs.push(
          `${def.id} [${def.module}] ${def.method} ${url} 期望=${def.expect} 实际=${response.statusCode}` +
          (contentOk ? '' : ` 内容不一致（${contentType}）${detail}`),
        );
      }
    }

    await app.close();
    db.close();
    setDatabase(null);
    setDb(null);
    process.env = previous;

    /* 已批准的差异（契约等价，见 MIG-11 交付记录）：
     * context-04/funds-09/comments-08：FastAPI pydantic 校验 422（detail 数组）vs Node 业务校验 400；
     * education-08：均为 500，Python 为 text/plain 纯文本、Node 为 JSON {detail}（旧行为缺陷）；
     * agent-02：工具元数据扩展（allow_channels/confirm_required，AGENT-02 确认机制新增字段）；
     * recycle-04：审计内容差异由上述 422/400 状态码差异级联产生。 */
    const approvedDiffs = new Set([
      'context-04', 'funds-09', 'comments-08', 'education-08', 'agent-02', 'recycle-04',
    ]);
    const unexpected = diffs.filter((line) => {
      const id = line.split(' ')[0];
      return !approvedDiffs.has(id);
    });
    const out = path.join(PROJECT_ROOT, 'migrate', 'baseline', 'out', 'api', 'contract-diffs.txt');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, diffs.join('\n') + '\n', 'utf-8');
    fs.writeFileSync(
      path.join(PROJECT_ROOT, 'migrate', 'baseline', 'out', 'api', 'contract-summary.txt'),
      `匹配 ${matched}/${CASES.length}；已批准差异 ${diffs.length - unexpected.length}；` +
      `未批准差异 ${unexpected.length}\n`,
      'utf-8',
    );
    // eslint-disable-next-line no-console
    console.log(
      `\n[contract] 匹配 ${matched}/${CASES.length}，已批准差异 ${diffs.length - unexpected.length}，` +
      `未批准 ${unexpected.length}`,
    );
    expect(unexpected).toEqual([]);
  });
});
