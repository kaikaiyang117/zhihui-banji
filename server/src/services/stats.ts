/* 统计服务：仪表盘聚合与个人工作台日历（与 backend/app/services/dashboard.py 语义一致）。 */
import { getDb, scopeIds } from './context.js';
import { todayString } from './clock.js';
import * as attendance from './attendance.js';
import * as points from './points.js';
import * as funds from './funds.js';
import * as workItems from './workItems.js';
import * as schoolCalendar from './schoolCalendar.js';
import { getRows } from './sheets.js';
import { pyRound } from './scores.js';
import type { Database } from 'better-sqlite3';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export class StatsError extends Error {}

function parseReferenceDate(text: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new StatsError('日期格式必须为 YYYY-MM-DD');
  return text;
}

function parseMonthText(text: string, reference: string): string {
  const value = String(text ?? '').trim();
  if (!value) return reference.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(value.slice(0, 7))) throw new StatsError('月份格式必须为 YYYY-MM');
  return value.slice(0, 7);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(dateText: string, days: number): string {
  const [y, m, d] = dateText.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + days));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
}

/** 个人工作台日历聚合：校历 + 未完成工作项 → 本月天数与未来 7 天安排。 */
export function calendar(options: {
  referenceDate?: string; month?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const referenceDate = options.referenceDate ? parseReferenceDate(options.referenceDate) : todayString();
  const monthText = parseMonthText(options.month ?? '', referenceDate);
  const [year, month] = monthText.split('-').map(Number);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
  const windowEnd = end > addDays(referenceDate, 7) ? end : addDays(referenceDate, 7);

  const schoolData = schoolCalendar.listCalendar(start, windowEnd) as { entries: Array<Record<string, unknown>> };
  const entriesByDate = new Map<string, Record<string, unknown>>();
  for (const entry of schoolData.entries ?? []) {
    const key = String(entry.calendar_date ?? '');
    if (key) entriesByDate.set(key, entry);
  }
  const tasks = workItems.listWorkItems({
    bucket: 'open', dateFrom: start, dateTo: windowEnd, limit: 100, conn,
  });
  const tasksByDate = new Map<string, Array<Record<string, unknown>>>();
  for (const task of tasks) {
    const taskDate = String(task.calendar_date ?? '');
    if (!taskDate) continue;
    if (!tasksByDate.has(taskDate)) tasksByDate.set(taskDate, []);
    tasksByDate.get(taskDate)!.push(task);
  }

  const days: Array<Record<string, unknown>> = [];
  for (let d = 1; d <= lastDayOfMonth(year, month); d += 1) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const entry = entriesByDate.get(iso);
    const dayTasks = tasksByDate.get(iso) ?? [];
    const jsDay = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    days.push({
      date: iso,
      day: d,
      weekday: (jsDay + 6) % 7,
      weekday_label: WEEKDAYS[(jsDay + 6) % 7],
      is_today: iso === referenceDate,
      school_calendar: entry ?? null,
      tasks: dayTasks,
      task_count: dayTasks.length,
      has_plan: Boolean(entry || dayTasks.length),
    });
  }

  const upcoming: Array<Record<string, unknown>> = [];
  for (let offset = 1; offset <= 7; offset += 1) {
    const iso = addDays(referenceDate, offset);
    if (iso > end) break;
    const entry = entriesByDate.get(iso);
    const dayTasks = tasksByDate.get(iso) ?? [];
    const items: Array<Record<string, unknown>> = [];
    if (entry && (String(entry.title ?? '') || !['上课日', '放假日'].includes(String(entry.day_type ?? '')))) {
      items.push({
        kind: '校历',
        title: String(entry.title ?? '') || String(entry.day_type ?? '') || '校历安排',
        meta: entry.is_school_day ? '上课日' : '非上课日',
      });
    }
    for (const task of dayTasks) {
      items.push({
        kind: '待办',
        title: String(task.title ?? '') || '未命名事项',
        meta: String(task.student_name ?? '') || String(task.source_label ?? '') || '班级事务',
        task,
      });
    }
    const jsDay = new Date(Date.UTC(
      Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)),
    )).getUTCDay();
    upcoming.push({
      date: iso,
      day: Number(iso.slice(8, 10)),
      weekday_label: WEEKDAYS[(jsDay + 6) % 7],
      school_calendar: entry ?? null,
      tasks: dayTasks,
      items,
      item_count: items.length,
    });
  }

  return {
    month: monthText,
    month_title: `${year}年${month}月`,
    start_date: start,
    end_date: end,
    days,
    upcoming,
    summary: {
      month_tasks: days.reduce((sum, day) => sum + Number(day.task_count ?? 0), 0),
      month_special: days.filter(day => {
        const entry = day.school_calendar as Record<string, unknown> | null;
        return Boolean(entry && (String(entry.title ?? '') || !['上课日', '放假日'].includes(String(entry.day_type ?? ''))));
      }).length,
      upcoming_items: upcoming.reduce((sum, item) => sum + Number(item.item_count ?? 0), 0),
    },
  };
}

/** 工作台仪表盘聚合（与 backend/app/routers/stats.py 的 /dashboard 语义一致）。 */
export function dashboard(date: string | undefined, options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });

  const totalStudents = Number((conn.prepare(
    "SELECT COUNT(*) AS n FROM student_enrollments e JOIN students s ON s.id=e.student_id " +
    "WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''",
  ).get(classId, termId) as { n: number }).n ?? 0);

  const targetDate = (date ?? todayString()).slice(0, 10);
  const referenceDate = parseReferenceDate(targetDate);
  const todayAtt = attendance.dashboardCounts(targetDate, conn);

  const pointSummary = points.classSummary({ referenceDate: targetDate, conn }) as {
    students: Array<Record<string, unknown>>;
  };
  const top = (pointSummary.students ?? [])
    .filter(item => Boolean(item.entry_count))
    .slice(0, 5)
    .map(item => ({ name: item.name, points: item.points }));

  const fundSummary = funds.classSummary({ referenceDate: targetDate, conn }) as {
    totals: Record<string, unknown>;
  };
  const balance = Number(fundSummary.totals?.balance ?? 0);

  const logRows = getRows('班主任日志');
  const logs = logRows
    .filter(r => r.data.length > 3 && r.data[0] && r.data[3])
    .map(r => ({
      date: String(r.data[0]).slice(0, 10),
      content: String(r.data[3]).slice(0, 50),
    }))
    .slice(-5);

  const workSummary = workItems.workItemSummary({ conn });
  const workSections: Record<string, Array<Record<string, unknown>>> = {};
  for (const bucket of ['overdue', 'today', 'next7']) {
    workSections[bucket] = workItems.listWorkItems({ bucket, limit: 8, conn });
  }
  const tasks = workItems.listWorkItems({ bucket: 'open', limit: 20, conn });
  const allRuleHits = workItems.listWorkItems({
    bucket: 'open', sourceType: 'attendance_rule', limit: 1_000_000, conn,
  });
  const ruleHits = allRuleHits.slice(0, 8);

  const focus = conn.prepare(
    "SELECT f.id, f.student_id, s.姓名 AS student_name, f.topic, f.reason, f.status, f.next_review_at " +
    "FROM focus_items f JOIN students s ON s.id=f.student_id " +
    "WHERE f.class_id=? AND f.term_id=? AND f.deleted_at='' AND s.deleted_at='' AND f.status != '已结束' " +
    "ORDER BY f.next_review_at, f.id DESC LIMIT 20",
  ).all(classId, termId);

  const recentEvents = conn.prepare(
    "SELECT e.id, e.occurred_at, e.event_type, e.description, e.status, e.student_id, s.姓名 AS student_name " +
    "FROM student_events e JOIN students s ON s.id=e.student_id " +
    "WHERE e.class_id=? AND e.term_id=? AND e.deleted_at='' AND s.deleted_at='' " +
    "ORDER BY e.occurred_at DESC, e.id DESC LIMIT 10",
  ).all(classId, termId);

  const pendingCommunications = conn.prepare(
    "SELECT c.id, c.student_id, s.姓名 AS student_name, c.followup_at, c.status, c.summary " +
    "FROM communications c JOIN students s ON s.id=c.student_id " +
    "WHERE c.class_id=? AND c.term_id=? AND c.deleted_at='' AND s.deleted_at='' AND c.followup_at != '' " +
    "AND c.status NOT IN ('已完成','已解决') " +
    "ORDER BY c.followup_at, c.id DESC LIMIT 20",
  ).all(classId, termId);

  const pendingCommunicationCount = Number((conn.prepare(
    "SELECT COUNT(*) AS n FROM communications c JOIN students s ON s.id=c.student_id " +
    "WHERE c.class_id=? AND c.term_id=? AND c.deleted_at='' AND s.deleted_at='' AND c.followup_at != '' " +
    "AND c.status NOT IN ('已完成','已解决')",
  ).get(classId, termId) as { n: number }).n ?? 0);

  const materialTaskRows = conn.prepare(
    "SELECT ct.id, ct.title, ct.task_type, ct.material_name, ct.due_at, ct.status, " +
    "COUNT(i.id) AS total, " +
    "SUM(CASE WHEN i.status='已提交' THEN 1 ELSE 0 END) AS submitted " +
    "FROM class_tasks ct " +
    "LEFT JOIN class_task_items i ON i.task_id=ct.id " +
    "WHERE ct.class_id=? AND ct.term_id=? AND ct.deleted_at='' " +
    "AND ct.status NOT IN ('已完成','已取消') " +
    "GROUP BY ct.id " +
    "ORDER BY CASE WHEN ct.due_at='' THEN 1 ELSE 0 END, ct.due_at, ct.id DESC",
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const materialTasks = materialTaskRows.map(item => {
    const submitted = Number(item.submitted ?? 0);
    const total = Number(item.total ?? 0);
    return {
      ...item,
      submitted,
      total,
      progress: total ? pyRound((submitted * 100) / total) : 0,
    };
  });

  const reviewStudents = conn.prepare(
    "SELECT f.id, f.student_id, s.姓名 AS student_name, f.topic, f.reason, f.status, f.next_review_at " +
    "FROM focus_items f JOIN students s ON s.id=f.student_id " +
    "WHERE f.class_id=? AND f.term_id=? AND f.deleted_at='' AND s.deleted_at='' " +
    "AND f.status<>'已结束' AND f.next_review_at<>'' AND substr(f.next_review_at,1,10)<=? " +
    "ORDER BY f.next_review_at, f.id DESC",
  ).all(classId, termId, targetDate);

  const calendarData = calendar({ referenceDate, conn });

  return {
    date: targetDate,
    total_students: totalStudents,
    today_attendance: todayAtt,
    top_points: top,
    recent_logs: logs,
    class_fund_balance: balance,
    work_summary: workSummary,
    work_sections: workSections,
    tasks,
    rule_hits: ruleHits,
    rule_hit_count: allRuleHits.length,
    material_tasks: materialTasks.slice(0, 8),
    material_task_count: materialTasks.length,
    review_students: reviewStudents.slice(0, 8),
    review_student_count: reviewStudents.length,
    focus,
    recent_events: recentEvents,
    pending_communications: pendingCommunications,
    pending_communication_count: pendingCommunicationCount,
    calendar: calendarData,
  };
}
