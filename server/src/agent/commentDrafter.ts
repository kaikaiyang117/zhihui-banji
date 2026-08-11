import type { Database } from 'better-sqlite3';

import * as attendance from '../services/attendance.js';
import { todayString } from '../services/clock.js';
import { getCurrentScope, getDb, type ScopeInfo } from '../services/context.js';
import * as points from '../services/points.js';
import * as scores from '../services/scores.js';
import * as workItems from '../services/workItems.js';
import { ModelError, OpenAICompatibleClient, type ModelResponse } from './modelClient.js';

export class CommentAIDraftError extends Error {}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function clip(value: unknown, limit = 120): string {
  const t = text(value);
  return t.length <= limit ? t : t.slice(0, limit - 1) + '…';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseJson(content: string): Record<string, unknown> {
  const raw = text(content).replace(/^```(?:json)?\s*|\s*```$/gi, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new CommentAIDraftError('AI返回内容不是有效的结构化评语结果');
  }
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new CommentAIDraftError('AI返回内容无法解析为评语结果');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)
    || !Array.isArray((data as Record<string, unknown>)['items'])) {
    throw new CommentAIDraftError('AI返回结果缺少评语列表');
  }
  return data as Record<string, unknown>;
}

function periodOf(scope: ScopeInfo): [string, string] {
  const today = todayString();
  return [
    (text(scope.start_date) || `${today.slice(0, 4)}-01-01`).slice(0, 10),
    (text(scope.end_date) || today).slice(0, 10),
  ];
}

function activeStudents(
  conn: Database,
  classId: number,
  termId: number,
  studentIds?: number[] | null,
): Array<Record<string, unknown>> {
  const rows = conn.prepare(
    `SELECT s.id, s.学号, s.姓名, s.特长, s.班级任职
     FROM students s JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.学号, s.id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const requested = new Set((studentIds ?? []).map((value) => Number(value)));
  if (requested.size === 0) return rows;
  const found = new Set(rows.map((row) => Number(row.id)));
  for (const id of requested) {
    if (!found.has(id)) throw new CommentAIDraftError('选择的学生中有不在当前班级或学期的记录');
  }
  return rows.filter((row) => requested.has(Number(row.id)));
}

function scoreFacts(
  studentId: number,
  start: string,
  end: string,
  conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const records = scores.listRecords({ studentId, conn }).filter((row) => {
    const examDate = text(row.exam_date);
    if (!examDate) return true;
    return start <= examDate.slice(0, 10) && examDate.slice(0, 10) <= end;
  });
  const bySubject = new Map<string, Array<[string, number]>>();
  for (const row of records) {
    const value = Number(row.score);
    if (!Number.isFinite(value)) continue;
    const subject = text(row.subject);
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject)!.push([text(row.exam_date), value]);
  }
  const changes: Array<Record<string, unknown>> = [];
  for (const [subject, values] of bySubject) {
    values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (values.length >= 2) {
      changes.push({ subject, delta: round1(values[values.length - 1][1] - values[0][1]) });
    }
  }
  changes.sort((a, b) => Math.abs(Number(b.delta)) - Math.abs(Number(a.delta)));
  const refs = records.length > 0
    ? [{
      source: '成绩',
      record_ids: records.slice(0, 20).map((row) => Number(row.id)),
      detail: `${records.length}条学期成绩记录`,
    }]
    : [];
  return [{
    record_count: records.length,
    exam_count: new Set(records.map((row) => text(row.exam_name))).size,
    subject_changes: changes.slice(0, 8),
    recent_scores: records.slice(-20).map((row) => ({
      exam: text(row.exam_name),
      subject: text(row.subject),
      score: row.score,
      status: text(row.record_status),
    })),
  }, refs];
}

function attendanceFacts(
  studentId: number,
  start: string,
  end: string,
  conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const records = attendance.listRecords({ studentId, dateFrom: start, dateTo: end, limit: 5000, conn });
  const counts: Record<string, number> = {};
  for (const row of records) {
    const status = text(row.status);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const anomalies = records.filter((row) => row.status !== '' && row.status !== '出勤');
  const refs = anomalies.length > 0
    ? [{
      source: '考勤',
      record_ids: anomalies.slice(0, 12).map((row) => Number(row.id)),
      detail: `${anomalies.length}次异常考勤`,
    }]
    : [];
  return [{
    record_count: records.length,
    status_counts: counts,
    anomaly_count: anomalies.length,
    recent_anomalies: anomalies.slice(0, 6).map((row) => ({
      date: text(row.attendance_date),
      status: text(row.status),
      reason: clip(row.reason, 80),
    })),
  }, refs];
}

function pointFacts(
  studentId: number,
  start: string,
  end: string,
  conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const records = points.listEntries({ studentId, dateFrom: start, dateTo: end, limit: 5000, conn })
    .filter((row) => row.status === '有效');
  const categories: Record<string, { count: number; positive: number; negative: number }> = {};
  for (const row of records) {
    const category = text(row.category) || '未分类';
    const bucket = categories[category] ?? { count: 0, positive: 0, negative: 0 };
    bucket.count += 1;
    if (Number(row.amount ?? 0) > 0) {
      bucket.positive += 1;
    } else {
      bucket.negative += 1;
    }
    categories[category] = bucket;
  }
  const refs = records.length > 0
    ? [{
      source: '行为积分',
      record_ids: records.slice(0, 12).map((row) => Number(row.id)),
      detail: `${records.length}条有效行为记录，不用于计算奖学金总分`,
    }]
    : [];
  const recentReasons: string[] = [];
  for (const row of records.slice(0, 6)) {
    if (row.reason) recentReasons.push(clip(row.reason, 80));
  }
  return [{
    record_count: records.length,
    categories,
    recent_reasons: recentReasons,
  }, refs];
}

function processFacts(
  studentId: number,
  classId: number,
  termId: number,
  start: string,
  end: string,
  conn: Database,
): [Record<string, unknown>, Array<Record<string, unknown>>] {
  const work = workItems.listWorkItems({ studentId, dateFrom: start, dateTo: end, limit: 200, conn });
  const events = conn.prepare(
    `SELECT id, occurred_at, event_type, description, status FROM student_events
     WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at=''
       AND substr(occurred_at,1,10) BETWEEN ? AND ?
     ORDER BY occurred_at DESC, id DESC LIMIT 20`,
  ).all(studentId, classId, termId, start, end) as Array<Record<string, unknown>>;
  const focus = conn.prepare(
    `SELECT id, topic, status, conclusion FROM focus_items
     WHERE student_id=? AND class_id=? AND term_id=? AND deleted_at=''
       AND (conclusion<>'' OR status IN ('情况改善','已结束'))
     ORDER BY updated_at DESC, id DESC LIMIT 8`,
  ).all(studentId, classId, termId) as Array<Record<string, unknown>>;
  const refs: Array<Record<string, unknown>> = [];
  if (events.length > 0) {
    refs.push({
      source: '学生事件',
      record_ids: events.map((row) => Number(row.id)),
      detail: `${events.length}条学期事件`,
    });
  }
  if (focus.length > 0) {
    refs.push({
      source: '关注事项',
      record_ids: focus.map((row) => Number(row.id)),
      detail: `${focus.length}条已形成结论的关注事项`,
    });
  }
  if (work.length > 0) {
    refs.push({
      source: '待办跟进',
      record_ids: work.slice(0, 12).map((row) => Number(row.id)),
      detail: `${work.length}条跟进工作项`,
    });
  }
  return [{
    work_items: {
      total: work.length,
      completed: work.filter((row) => row.status === '已完成').length,
      open: work.filter((row) => row.status !== '已完成' && row.status !== '已取消').length,
    },
    events: events.slice(0, 8).map((row) => ({
      date: text(row.occurred_at).slice(0, 10),
      type: text(row.event_type),
      description: clip(row.description),
      status: text(row.status),
    })),
    followups: focus.map((row) => ({
      topic: clip(row.topic, 60),
      status: text(row.status),
      conclusion: clip(row.conclusion, 100),
    })),
  }, refs];
}

export function buildStudentTermContext(
  studentId: number,
  options: { conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const scope = getCurrentScope({ conn });
  const classId = Number(scope.class_id);
  const termId = Number(scope.term_id);
  const student = activeStudents(conn, classId, termId, [studentId])[0];
  if (!student) {
    throw new CommentAIDraftError('学生不存在或不在当前班级/学期');
  }
  const [start, end] = periodOf(scope);
  const [scoreData, scoreRefs] = scoreFacts(studentId, start, end, conn);
  const [attendanceData, attendanceRefs] = attendanceFacts(studentId, start, end, conn);
  const [pointData, pointRefs] = pointFacts(studentId, start, end, conn);
  const [processData, processRefs] = processFacts(studentId, classId, termId, start, end, conn);
  const evidence = [...scoreRefs, ...attendanceRefs, ...pointRefs, ...processRefs];
  const available: string[] = [];
  if (Number(scoreData.record_count) > 0) available.push('成绩');
  if (Number(attendanceData.anomaly_count) > 0) available.push('异常考勤');
  if (Number(pointData.record_count) > 0) available.push('行为记录');
  const eventsList = Array.isArray(processData.events) ? processData.events as unknown[] : [];
  const followupsList = Array.isArray(processData.followups) ? processData.followups as unknown[] : [];
  if (eventsList.length > 0 || followupsList.length > 0) {
    available.push('过程记录');
  }
  return {
    student_id: Number(student.id),
    学号: text(student['学号']),
    姓名: text(student['姓名']),
    profile: { 特长: clip(student['特长'], 80), 班级任职: clip(student['班级任职'], 80) },
    period: { start, end, term: text(scope.term_name) },
    facts: { 成绩: scoreData, 考勤: attendanceData, 行为记录: pointData, 过程记录: processData },
    evidence,
    coverage: { available_sources: available, source_count: evidence.length },
  };
}

export function buildStudentTermContexts(
  studentIds?: number[] | null,
  options: { conn?: Database } = {},
): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const scope = getCurrentScope({ conn });
  const students = activeStudents(conn, Number(scope.class_id), Number(scope.term_id), studentIds);
  return students.map((row) => buildStudentTermContext(Number(row.id), { conn }));
}

export async function previewGeneration(options: {
  student_ids?: number[] | null;
  studentIds?: number[] | null;
  comment_type?: string;
  commentType?: string;
  tone?: string;
  length?: string;
  instruction?: string;
  model_client?: OpenAICompatibleClient;
  modelClient?: OpenAICompatibleClient;
  conn?: Database;
} = {}): Promise<Record<string, unknown>> {
  const studentIds = options.studentIds ?? options.student_ids ?? null;
  const commentType = text(options.commentType ?? options.comment_type ?? '') || '学期评语';
  if (commentType !== '学期评语') {
    throw new CommentAIDraftError('AI学期评语暂只支持“学期评语”类型');
  }
  const contexts = buildStudentTermContexts(studentIds, { conn: options.conn });
  if (contexts.length === 0) {
    throw new CommentAIDraftError('请至少选择一名学生');
  }
  if (contexts.length > 30) {
    throw new CommentAIDraftError('一次最多生成30名学生的评语');
  }
  const client = options.modelClient ?? options.model_client ?? new OpenAICompatibleClient();
  const system = (
    '你是高中班主任的评语助手。只能根据用户提供的学生学期事实生成评语草稿，绝不补充不存在的事实。'
    + '使用中文，客观、具体、尊重学生；避免同学比较、排名、医学或心理诊断、家庭隐私和标签化判断；'
    + '正常出勤不要逐日罗列；行为积分只作为行为记录参考，不计算奖学金或综合分数；数据不足时省略对应判断。'
    + '输出严格 JSON，不要 Markdown：{"items":[{"student_id":1,"content":"评语草稿","evidence":["成绩：..."],"warnings":[]}] }。每名学生必须返回一条。'
  );
  const user: Record<string, unknown> = {
    '任务': '生成本学期学生评语草稿',
    '评语类型': commentType,
    '语言风格': options.tone ?? '温和、客观、鼓励',
    '建议字数': options.length ?? '120-160字',
    '老师补充要求': clip(options.instruction ?? '', 300),
    '学生学期事实': contexts,
  };
  let response: ModelResponse;
  try {
    response = await client.complete([
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) },
    ]);
  } catch (error) {
    if (error instanceof ModelError) {
      throw new CommentAIDraftError(error.message);
    }
    throw error;
  }
  const data = parseJson(response.content);
  const contextById = new Map<number, Record<string, unknown>>();
  for (const item of contexts) contextById.set(Number(item.student_id), item);
  const rows: Array<Record<string, unknown>> = [];
  for (const item of (data['items'] as Array<Record<string, unknown>>)) {
    let studentId: number;
    try {
      studentId = Number(item.student_id);
      if (!Number.isInteger(studentId)) throw new Error();
    } catch {
      continue;
    }
    const context = contextById.get(studentId);
    const content = clip(item.content, 500);
    if (!context || !content) continue;
    rows.push({
      student_id: studentId,
      学号: context['学号'],
      姓名: context['姓名'],
      content,
      evidence: (Array.isArray(item.evidence) ? item.evidence : []).map((value) => String(value)).slice(0, 6),
      warnings: (Array.isArray(item.warnings) ? item.warnings : []).map((value) => String(value)).slice(0, 6),
      coverage: context['coverage'],
    });
  }
  const returnedIds = new Set(rows.map((row) => Number(row.student_id)));
  for (const context of contexts) {
    const studentId = Number(context.student_id);
    if (returnedIds.has(studentId)) continue;
    rows.push({
      student_id: studentId,
      学号: context['学号'],
      姓名: context['姓名'],
      content: '',
      evidence: [],
      warnings: ['AI未返回评语，请手工填写或重新生成'],
      coverage: context['coverage'],
    });
  }
  return {
    comment_type: commentType,
    model: client.config.model,
    period: contexts[0]['period'],
    rows,
    summary: {
      requested: contexts.length,
      generated: rows.filter((row) => row.content).length,
      warnings: rows.filter((row) => row.warnings && (row.warnings as unknown[]).length > 0).length,
      low_coverage: rows.filter((row) => (row.coverage as Record<string, unknown>)['source_count'] === 0).length,
    },
  };
}
