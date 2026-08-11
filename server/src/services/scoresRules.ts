import type { Database } from 'better-sqlite3';

import { bindRequestScope, getDb, resetRequestScope, scopeIds } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';
import { ensureSourceWorkItem, sourceTransitionHooks, updateWorkItem } from './workItems.js';
import {
  formatG, OPEN_TASK_STATUSES, positiveNumber, pyRound, RULE_METRICS, RULE_TRIGGERS,
  ScoreError, scoreSummary, subjectRow, text, nowText,
} from './scores.js';

export function listRules(options: {
  sourceId?: number | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const params: unknown[] = [classId, termId];
  let sql = `SELECT r.*, s.name AS subject_name FROM score_rules r
             LEFT JOIN score_subjects s ON s.id=r.subject_id
             WHERE r.class_id=? AND r.term_id=? AND r.deleted_at=''`;
  if (options.sourceId) {
    sql += ' AND r.id=?';
    params.push(Number(options.sourceId));
  }
  const rules = conn.prepare(
    sql + ' ORDER BY r.enabled DESC, r.id',
  ).all(...params) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    rule.enabled = Boolean(rule.enabled);
    rule.hits = conn.prepare(
      `SELECT h.*, s.学号, s.姓名 AS student_name,
              p.name AS previous_exam_name, c.name AS current_exam_name,
              t.status AS task_status, t.result AS task_result
       FROM score_rule_hits h JOIN students s ON s.id=h.student_id
       LEFT JOIN score_exams p ON p.id=h.previous_exam_id
       LEFT JOIN score_exams c ON c.id=h.current_exam_id
       LEFT JOIN student_tasks t ON t.id=h.task_id
       WHERE h.class_id=? AND h.term_id=? AND h.rule_id=?
       ORDER BY CASE h.status WHEN '待处理' THEN 0 WHEN '已处理' THEN 1 ELSE 2 END,
                h.last_hit_at DESC, h.id DESC`,
    ).all(classId, termId, Number(rule.id)) as Array<Record<string, unknown>>;
    rule.active_hit_count = (rule.hits as Array<Record<string, unknown>>)
      .filter((item) => item.status === '待处理').length;
    rule.handled_hit_count = (rule.hits as Array<Record<string, unknown>>)
      .filter((item) => item.status === '已处理').length;
  }
  const runs = conn.prepare(
    'SELECT * FROM score_rule_runs WHERE class_id=? AND term_id=? ORDER BY id DESC LIMIT 20',
  ).all(classId, termId) as Array<Record<string, unknown>>;
  for (const run of runs) {
    const raw = run.summary_json;
    delete run.summary_json;
    try {
      run.summary = JSON.parse(String(raw ?? '[]'));
    } catch {
      run.summary = [];
    }
  }
  return { rules, recent_runs: runs };
}

export function createRule(options: {
  name?: unknown; metric?: string; threshold?: unknown; subjectId?: number | null;
  priority?: unknown; enabled?: boolean; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const name = text(options.name);
  if (!name) throw new ScoreError('规则名称不能为空');
  const metric = String(options.metric ?? '');
  if (!RULE_METRICS.has(metric)) throw new ScoreError('不支持的成绩规则指标');
  const threshold = positiveNumber(options.threshold, '阈值', { allowZero: false });
  let subjectId = options.subjectId !== undefined && options.subjectId !== null
    ? Number(options.subjectId) : null;
  if (metric === '单科下降') {
    if (!subjectId) throw new ScoreError('单科下降规则必须选择科目');
    subjectRow(subjectId, { write: true, conn });
  } else {
    subjectId = null;
  }
  const enabled = options.enabled ?? true;
  const [classId, termId] = scopeIds({ write: true, conn });
  const ruleId = conn.transaction(() => {
    const inserted = conn.prepare(
      `INSERT INTO score_rules(
         class_id, term_id, name, metric, subject_id, threshold, priority, enabled
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(classId, termId, name, metric, subjectId, threshold,
      text(options.priority) || '重要', enabled ? 1 : 0);
    const id = Number(inserted.lastInsertRowid);
    audit.record('score_rule', id, 'create', {
      summary: `新增成绩规则：${name}`,
      params: { metric, subject_id: subjectId, threshold },
      classId, termId, conn,
    });
    return id;
  })();
  const evaluation = enabled ? evaluateRules({ trigger: 'rule_change', conn }) : null;
  return { ok: true, rule_id: ruleId, evaluation };
}

function resolveOpenTask(taskId: number | null, result: string, conn: Database): boolean {
  if (!taskId) return false;
  const row = conn.prepare(
    "SELECT status FROM student_tasks WHERE id=? AND deleted_at=''",
  ).get(taskId) as { status: string } | undefined;
  if (!row || !OPEN_TASK_STATUSES.has(row.status)) return false;
  updateWorkItem(taskId, { status: '已取消', result, conn });
  return true;
}

function resolveHits(ruleId: number, result: string, conn: Database): number {
  const [classId, termId] = scopeIds({ write: true, conn });
  const rows = conn.prepare(
    `SELECT * FROM score_rule_hits WHERE rule_id=? AND class_id=? AND term_id=?
     AND status<>'已解除'`,
  ).all(ruleId, classId, termId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    resolveOpenTask(
      row.task_id !== null && row.task_id !== undefined ? Number(row.task_id) : null,
      result, conn,
    );
    conn.prepare(
      `UPDATE score_rule_hits SET status='已解除', resolved_at=?,
       updated_at=datetime('now','localtime') WHERE id=?`,
    ).run(nowText(), Number(row.id));
  }
  return rows.length;
}

export function updateRule(ruleId: number, options: {
  enabled?: boolean | null; threshold?: unknown; priority?: unknown; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const current = conn.prepare(
    "SELECT * FROM score_rules WHERE id=? AND class_id=? AND term_id=? AND deleted_at=''",
  ).get(Number(ruleId), classId, termId) as Record<string, unknown> | undefined;
  if (!current) throw new ScoreError('成绩规则不存在');
  const fields: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};
  if (options.enabled !== undefined && options.enabled !== null) {
    fields.push('enabled=?');
    params.push(options.enabled ? 1 : 0);
    changes.enabled = Boolean(options.enabled);
  }
  if (options.threshold !== undefined && options.threshold !== null) {
    const value = positiveNumber(options.threshold, '阈值', { allowZero: false });
    fields.push('threshold=?');
    params.push(value);
    changes.threshold = value;
  }
  if (options.priority !== undefined && options.priority !== null) {
    const value = text(options.priority);
    fields.push('priority=?');
    params.push(value);
    changes.priority = value;
  }
  if (fields.length === 0) return { ok: true, evaluation: null, resolved_count: 0 };
  const nextEnabled = options.enabled !== undefined && options.enabled !== null
    ? Boolean(options.enabled) : Boolean(current.enabled);
  let resolved = 0;
  conn.transaction(() => {
    conn.prepare(
      `UPDATE score_rules SET ${fields.join(', ')},
       updated_at=datetime('now','localtime') WHERE id=?`,
    ).run(...params, Number(ruleId));
    if (!nextEnabled) {
      resolved = resolveHits(Number(ruleId), '成绩规则已停用，系统自动解除提醒', conn);
    }
    audit.record('score_rule', Number(ruleId), 'update', {
      summary: `更新成绩规则：${String(current.name)}`,
      params: changes, classId, termId, conn,
    });
  })();
  const evaluation = nextEnabled ? evaluateRules({ trigger: 'rule_change', conn }) : null;
  return { ok: true, evaluation, resolved_count: resolved };
}

function activateTask(
  rule: Record<string, unknown>, student: Record<string, unknown>,
  previousExam: Record<string, unknown>, currentExam: Record<string, unknown>,
  value: number, options: { rehit: boolean; conn: Database },
): [number, boolean, boolean] {
  const { rehit, conn } = options;
  const subjectText = rule.subject_name ? ` · ${String(rule.subject_name)}` : '';
  const title = `成绩提醒 · ${String(student['姓名'])} · ${String(rule.name)}`;
  const notes = `${String(previousExam.exam_name)} → ${String(currentExam.exam_name)}，`
    + `${String(rule.metric)}${subjectText}达到 ${formatG(value)}，`
    + `阈值 ${formatG(Number(rule.threshold))}`;
  const task = ensureSourceWorkItem({
    title, legacyTitle: title, studentId: Number(student.student_id),
    sourceType: 'score_rule', sourceId: Number(rule.id),
    dueAt: String(currentExam.exam_date ?? '') || todayString(),
    priority: String(rule.priority), status: '待处理', notes, conn,
  });
  const taskId = Number(task.id);
  const row = conn.prepare(
    `SELECT status, title, priority, due_at, notes FROM student_tasks
     WHERE id=? AND deleted_at=''`,
  ).get(taskId) as Record<string, unknown> | undefined;
  const dueAt = String(currentExam.exam_date ?? '') || todayString();
  let reopened = false;
  if (row && !OPEN_TASK_STATUSES.has(String(row.status)) && (rehit || !task.created)) {
    updateWorkItem(taskId, {
      title, priority: String(rule.priority), status: '待处理',
      dueAt, notes, conn,
    });
    reopened = true;
  } else if (row && OPEN_TASK_STATUSES.has(String(row.status)) && (
    String(row.title) !== title
    || String(row.priority) !== String(rule.priority)
    || String(row.due_at) !== dueAt
    || String(row.notes) !== notes
  )) {
    updateWorkItem(taskId, {
      title, priority: String(rule.priority), dueAt, notes, conn,
    });
  }
  return [taskId, Boolean(task.created), reopened];
}

function rulePair(
  rule: Record<string, unknown>, student: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>, number] | null {
  const comparable: Array<[Record<string, unknown>, number]> = [];
  for (const exam of student.exams as Array<Record<string, unknown>>) {
    let value: number | null = null;
    if (rule.metric === '总分下降' && exam.total !== null && exam.total !== undefined) {
      value = Number(exam.total);
    } else if (rule.metric === '排名下降' && exam.rank !== null && exam.rank !== undefined) {
      value = Number(exam.rank);
    } else if (rule.metric === '单科下降') {
      const subject = (exam.subjects as Record<string, Record<string, unknown>>)
        ?.[String(rule.subject_name ?? '')];
      if (subject && String(subject.status) === '正常'
        && subject.score !== null && subject.score !== undefined) {
        value = Number(subject.score);
      }
    }
    if (value !== null) comparable.push([exam, value]);
  }
  if (comparable.length < 2) return null;
  const previous = comparable[comparable.length - 2];
  const current = comparable[comparable.length - 1];
  const decline = rule.metric === '排名下降'
    ? current[1] - previous[1] : previous[1] - current[1];
  return [previous[0], current[0], pyRound(decline, 2)];
}

export function evaluateRules(options: {
  trigger?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const trigger = options.trigger ?? 'manual';
  if (!RULE_TRIGGERS.has(trigger)) throw new ScoreError('规则执行来源不合法');
  const [classId, termId] = scopeIds({ write: true, conn });
  const rules = conn.prepare(
    `SELECT r.*, s.name AS subject_name FROM score_rules r
     LEFT JOIN score_subjects s ON s.id=r.subject_id
     WHERE r.class_id=? AND r.term_id=? AND r.enabled=1 AND r.deleted_at=''
     ORDER BY r.id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const data = scoreSummary({ conn });
  const students = data.students as Array<Record<string, unknown>>;
  const now = nowText();
  let hitCount = 0;
  let createdCount = 0;
  let reopenedCount = 0;
  let resolvedCount = 0;
  const output: Array<Record<string, unknown>> = [];
  let runId: number;
  try {
    runId = conn.transaction(() => {
      for (const rule of rules) {
        for (const student of students) {
          const pair = rulePair(rule, student);
          const hit = conn.prepare(
            `SELECT * FROM score_rule_hits
             WHERE class_id=? AND term_id=? AND rule_id=? AND student_id=?`,
          ).get(classId, termId, Number(rule.id), Number(student.student_id)) as
            Record<string, unknown> | undefined;
          const previousExam = pair ? pair[0] : null;
          const currentExam = pair ? pair[1] : null;
          const value = pair ? pair[2] : 0;
          const matched = Boolean(pair && value >= Number(rule.threshold));
          if (matched) {
            hitCount += 1;
            const hitDict = hit ?? null;
            const newExam = Number(currentExam!.exam_id);
            const newCycle = hitDict === null
              || String(hitDict.status) === '已解除'
              || (String(hitDict.status) === '已处理'
                && Number(hitDict.current_exam_id ?? 0) !== newExam);
            let taskId: number | null;
            let created = false;
            let reopened = false;
            if (newCycle || (hitDict && String(hitDict.status) === '待处理')) {
              [taskId, created, reopened] = activateTask(
                rule, student, previousExam!, currentExam!, value,
                { rehit: Boolean(hitDict && newCycle), conn },
              );
            } else {
              taskId = hitDict && hitDict.task_id ? Number(hitDict.task_id) : null;
              created = false;
              reopened = false;
            }
            createdCount += created ? 1 : 0;
            reopenedCount += reopened ? 1 : 0;
            const nextStatus = newCycle ? '待处理' : String(hitDict?.status ?? '待处理');
            if (hitDict) {
              conn.prepare(
                `UPDATE score_rule_hits SET status=?, current_value=?,
                       previous_exam_id=?, current_exam_id=?, task_id=?, last_hit_at=?,
                       handled_at=CASE WHEN ?='待处理' THEN '' ELSE handled_at END,
                       resolved_at='', updated_at=datetime('now','localtime') WHERE id=?`,
              ).run(nextStatus, value, Number(previousExam!.exam_id),
                Number(currentExam!.exam_id), taskId, now, nextStatus, Number(hitDict.id));
            } else {
              conn.prepare(
                `INSERT INTO score_rule_hits(
                       rule_id, student_id, class_id, term_id, status,
                       current_value, previous_exam_id, current_exam_id,
                       task_id, first_hit_at, last_hit_at
                   ) VALUES(?,?,?,?,'待处理',?,?,?,?,?,?)`,
              ).run(Number(rule.id), Number(student.student_id), classId, termId, value,
                Number(previousExam!.exam_id), Number(currentExam!.exam_id), taskId, now, now);
            }
            output.push({
              rule_id: rule.id, rule: rule.name,
              student_id: student.student_id, student_name: student['姓名'],
              previous_exam: previousExam!.exam_name,
              current_exam: currentExam!.exam_name, value,
              state: !hitDict ? '新命中' : (newCycle ? '重新命中' : nextStatus),
            });
          } else if (hit && String(hit.status) !== '已解除') {
            resolveOpenTask(
              hit.task_id !== null && hit.task_id !== undefined ? Number(hit.task_id) : null,
              '成绩指标已恢复，系统自动解除提醒', conn,
            );
            conn.prepare(
              `UPDATE score_rule_hits SET status='已解除', current_value=?,
                     resolved_at=?, updated_at=datetime('now','localtime') WHERE id=?`,
            ).run(value, now, Number(hit.id));
            resolvedCount += 1;
          }
        }
        conn.prepare(
          `UPDATE score_rules SET last_run_at=?,
           updated_at=datetime('now','localtime') WHERE id=?`,
        ).run(now, Number(rule.id));
      }
      const inserted = conn.prepare(
        `INSERT INTO score_rule_runs(
               class_id, term_id, trigger_type, rules_evaluated, students_evaluated,
               hit_count, created_count, reopened_count, resolved_count, status, summary_json
           ) VALUES(?,?,?,?,?,?,?,?,?,'success',?)`,
      ).run(classId, termId, trigger, rules.length, students.length, hitCount,
        createdCount, reopenedCount, resolvedCount, JSON.stringify(output));
      const id = Number(inserted.lastInsertRowid);
      audit.record('score_rules', id, 'evaluate', {
        summary: `执行 ${rules.length} 条成绩规则：命中 ${hitCount}，`
          + `新建 ${createdCount}，重开 ${reopenedCount}，解除 ${resolvedCount}`,
        params: { trigger }, classId, termId, conn,
      });
      return id;
    })();
  } catch (error) {
    conn.prepare(
      `INSERT INTO score_rule_runs(
             class_id, term_id, trigger_type, rules_evaluated,
             students_evaluated, status, error
         ) VALUES(?,?,?,?,?,'failed',?)`,
    ).run(classId, termId, trigger, rules.length, students.length,
      String((error as Error).message).slice(0, 500));
    throw error;
  }
  return {
    run_id: runId, trigger, rules_evaluated: rules.length,
    students_evaluated: students.length, hit_count: hitCount,
    created_count: createdCount, reopened_count: reopenedCount,
    resolved_count: resolvedCount, summary: output,
  };
}

export function onWorkItemTransition(
  conn: Database, before: Record<string, unknown>, nextStatus: string,
): void {
  if (String(before.source_type ?? '') !== 'score_rule') return;
  const now = nowText();
  if (nextStatus === '已完成' || nextStatus === '已取消') {
    conn.prepare(
      `UPDATE score_rule_hits SET status='已处理', handled_at=?,
       updated_at=datetime('now','localtime')
       WHERE task_id=? AND status='待处理'`,
    ).run(now, Number(before.id));
  } else if (OPEN_TASK_STATUSES.has(nextStatus)) {
    conn.prepare(
      `UPDATE score_rule_hits SET status='待处理', handled_at='', resolved_at='',
       updated_at=datetime('now','localtime') WHERE task_id=?`,
    ).run(Number(before.id));
  }
}

sourceTransitionHooks['score_rule'] = onWorkItemTransition;

export function evaluateStartup(options: { conn?: Database } = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const scopes = conn.prepare(
    `SELECT c.id AS class_id, t.id AS term_id FROM classes c
     JOIN terms t ON t.class_id=c.id
     WHERE c.status='使用中' AND t.status='进行中' ORDER BY c.id, t.id`,
  ).all() as Array<{ class_id: number; term_id: number }>;
  const results: Array<Record<string, unknown>> = [];
  for (const scope of scopes) {
    bindRequestScope(Number(scope.class_id), Number(scope.term_id));
    try {
      results.push(evaluateRules({ trigger: 'startup', conn }));
    } finally {
      resetRequestScope();
    }
  }
  return results;
}
