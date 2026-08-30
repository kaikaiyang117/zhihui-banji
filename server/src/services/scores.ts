import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { getDb, scopeIds } from './context.js';
import * as audit from './audit.js';
import { todayString } from './clock.js';

export const RECORD_STATUSES = new Set(['正常', '缺考', '免考']);
export const DUPLICATE_STRATEGIES = new Set(['update', 'skip']);
export const RULE_METRICS = new Set(['总分下降', '排名下降', '单科下降']);
export const RULE_TRIGGERS = new Set(['import', 'manual', 'rule_change', 'startup']);
export const OPEN_TASK_STATUSES = new Set(['待处理', '处理中', '待复查']);
export const SUBJECT_GROUPS = new Set(['必考', '首选', '再选', '选考']);
export const SCORE_TYPES = new Set(['原始分', '等级赋分']);
export const SCORE_MODES = new Set(['固定科目', '3+1+2', '3+3', '自定义']);

export interface Sichuan312Subject {
  name: string;
  aliases: Set<string>;
  full_score: number;
  group: string;
  score_type: string;
}

export const SICHUAN_312_SUBJECTS: Sichuan312Subject[] = [
  { name: '语文', aliases: new Set(['语文']), full_score: 150, group: '必考', score_type: '原始分' },
  { name: '数学', aliases: new Set(['数学']), full_score: 150, group: '必考', score_type: '原始分' },
  { name: '英语', aliases: new Set(['英语', '外语']), full_score: 150, group: '必考', score_type: '原始分' },
  { name: '物理', aliases: new Set(['物理']), full_score: 100, group: '首选', score_type: '原始分' },
  { name: '历史', aliases: new Set(['历史']), full_score: 100, group: '首选', score_type: '原始分' },
  { name: '化学', aliases: new Set(['化学']), full_score: 100, group: '再选', score_type: '等级赋分' },
  { name: '生物', aliases: new Set(['生物']), full_score: 100, group: '再选', score_type: '等级赋分' },
  { name: '政治', aliases: new Set(['政治', '思想政治']), full_score: 100, group: '再选', score_type: '等级赋分' },
  { name: '地理', aliases: new Set(['地理']), full_score: 100, group: '再选', score_type: '等级赋分' },
];

export const SICHUAN_312_FIRST = new Set(['物理', '历史']);
export const SICHUAN_312_SECOND = new Set(['化学', '生物', '政治', '地理']);
export const SICHUAN_312_SHORT_NAMES: Record<string, string> = {
  物理: '物', 历史: '史', 化学: '化', 生物: '生', 政治: '政', 地理: '地',
};

export class ScoreError extends Error {}

export function nowText(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

export function dateText(value: unknown): string {
  const candidate = text(value).slice(0, 10);
  if (!candidate) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
  if (!match) throw new ScoreError('考试日期格式必须为 YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ScoreError('考试日期格式必须为 YYYY-MM-DD');
  }
  return candidate;
}

export function positiveNumber(
  value: unknown, label: string, options: { allowZero?: boolean } = {},
): number {
  const allowZero = options.allowZero ?? true;
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const number = raw === '' ? Number.NaN : Number(raw);
  if (Number.isNaN(number)) throw new ScoreError(`${label}必须是数字`);
  if (number < 0 || (!allowZero && number === 0)) throw new ScoreError(`${label}不能小于零`);
  return number;
}

function addOneToDecimal(digits: string): string {
  const chars = digits.split('');
  let carry = 1;
  for (let index = chars.length - 1; index >= 0 && carry > 0; index -= 1) {
    const sum = Number(chars[index]) + carry;
    if (sum === 10) chars[index] = '0';
    else {
      chars[index] = String(sum);
      carry = 0;
    }
  }
  return carry > 0 ? `1${chars.join('')}` : chars.join('');
}

export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  const text = value.toFixed(digits + 20);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const intPart = unsigned.slice(0, dot);
  const frac = unsigned.slice(dot + 1);
  const keep = frac.slice(0, digits);
  const tail = frac.slice(digits);
  const split = (next: string): [string, string] => [
    next.slice(0, Math.max(0, next.length - digits)).replace(/^0+(?=\d)/, '') || '0',
    next.slice(Math.max(0, next.length - digits)),
  ];
  let roundedIntPart = intPart;
  let rounded = keep;
  if (tail) {
    const firstDigit = Number(tail[0]);
    const rest = tail.slice(1);
    const isHalf = firstDigit === 5 && [...rest].every((ch) => ch === '0');
    if (isHalf) {
      if (Number((intPart + keep).slice(-1)) % 2 === 1) {
        [roundedIntPart, rounded] = split(addOneToDecimal(intPart + keep));
      }
    } else if (firstDigit > 5 || (firstDigit === 5 && [...rest].some((ch) => ch > '0'))) {
      [roundedIntPart, rounded] = split(addOneToDecimal(intPart + keep));
    }
  }
  const withDot = `${roundedIntPart}.${rounded}`;
  return Number(`${negative ? '-' : ''}${withDot}`);
}

export function formatG(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(parseFloat(value.toFixed(6)));
}

function canonicalSubjectName(name: string): string {
  const value = text(name);
  for (const item of SICHUAN_312_SUBJECTS) {
    if (item.aliases.has(value)) return item.name;
  }
  return value;
}

function sichuanExpectedSubject(name: string): Sichuan312Subject | undefined {
  const canonical = canonicalSubjectName(name);
  return SICHUAN_312_SUBJECTS.find((item) => item.name === canonical);
}

function selectionError(
  mode: string, selectedIds: Set<number>, subjectById: Map<number, Record<string, unknown>>,
): string {
  if (mode === '固定科目' || mode === '自定义') return '';
  const selected = [...selectedIds]
    .filter((item) => subjectById.has(item))
    .map((item) => subjectById.get(item) as Record<string, unknown>);
  const firstCount = selected.filter((item) => item.subject_group === '首选').length;
  const secondCount = selected.filter((item) => item.subject_group === '再选').length;
  const electiveCount = selected.filter((item) => item.subject_group === '选考').length;
  if (mode === '3+1+2') {
    if (selected.length !== 3 || firstCount !== 1 || secondCount !== 2) {
      return '3+1+2选科必须是物理/历史二选一，并从化学、生物、政治、地理中选择两科';
    }
    const firstNames = new Set(
      selected.filter((item) => item.subject_group === '首选')
        .map((item) => canonicalSubjectName(String(item.name ?? ''))),
    );
    const secondNames = new Set(
      selected.filter((item) => item.subject_group === '再选')
        .map((item) => canonicalSubjectName(String(item.name ?? ''))),
    );
    const subset = (superset: Set<string>, values: Set<string>): boolean =>
      [...values].every((value) => superset.has(value));
    if (!subset(SICHUAN_312_FIRST, firstNames) || !subset(SICHUAN_312_SECOND, secondNames)) {
      return '首选科目只能是物理或历史，再选科目只能是化学、生物、政治或地理';
    }
    return '';
  }
  if (mode === '3+3') {
    return selected.length === 3 && electiveCount === 3 ? '' : '3+3选科必须选择三门选考科目';
  }
  return '';
}

function selectionStatus(
  mode: string, selectedIds: Set<number>, subjectById: Map<number, Record<string, unknown>>,
): string {
  if (selectedIds.size === 0 && mode !== '固定科目' && mode !== '自定义') return '组合不完整';
  return selectionError(mode, selectedIds, subjectById) ? '组合无效' : '有效';
}

function combinations<T>(values: T[], size: number): T[][] {
  const results: T[][] = [];
  const combine = (start: number, current: T[]): void => {
    if (current.length === size) {
      results.push([...current]);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      current.push(values[index]);
      combine(index + 1, current);
      current.pop();
    }
  };
  combine(0, []);
  return results;
}

function sichuan312Config(
  subjects: Array<Record<string, unknown>>, mode: string,
): Record<string, unknown> {
  const enabledSubjects = subjects.filter((item) => item.enabled);
  const byCanonical = new Map<string, Array<Record<string, unknown>>>();
  for (const subject of enabledSubjects) {
    const canonical = canonicalSubjectName(String(subject.name ?? ''));
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
    byCanonical.get(canonical)!.push(subject);
  }
  const issues: string[] = [];
  const subjectMap = new Map<string, Record<string, unknown>>();
  if (mode !== '3+1+2') issues.push('当前成绩制度不是3+1+2');
  for (const expected of SICHUAN_312_SUBJECTS) {
    const matched = byCanonical.get(expected.name) ?? [];
    if (matched.length === 0) {
      issues.push(`缺少${expected.name}科目`);
      continue;
    }
    if (matched.length > 1) {
      issues.push(`${expected.name}存在重复科目`);
      continue;
    }
    const subject = matched[0];
    subjectMap.set(expected.name, subject);
    if (String(subject.subject_group ?? '') !== expected.group) {
      issues.push(`${subject.name}应设为${expected.group}`);
    }
    if (String(subject.score_type ?? '') !== expected.score_type) {
      issues.push(`${subject.name}应使用${expected.score_type}`);
    }
  }
  const combinationRows: Array<Record<string, unknown>> = [];
  const allPresent = [...SICHUAN_312_FIRST].every((name) => subjectMap.has(name))
    && [...SICHUAN_312_SECOND].every((name) => subjectMap.has(name));
  if (allPresent) {
    const secondOrder = ['化学', '生物', '政治', '地理'];
    for (const firstName of ['物理', '历史']) {
      for (const secondNames of combinations(secondOrder, 2)) {
        const names = [firstName, ...secondNames];
        combinationRows.push({
          code: names.map((name) => SICHUAN_312_SHORT_NAMES[name]).join(''),
          label: names.join(' + '),
          first_subject: firstName,
          subject_ids: names.map((name) => Number(subjectMap.get(name)!.id)),
        });
      }
    }
  }
  return {
    ready: issues.length === 0,
    issues,
    combinations: combinationRows,
    standard_subject_ids: [...subjectMap.values()].map((item) => Number(item.id)),
  };
}

export function listConfig(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const subjects = conn.prepare(
    'SELECT * FROM score_subjects WHERE class_id=? AND term_id=? '
    + 'ORDER BY enabled DESC, sort_order, id',
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const settingsRow = conn.prepare(
    'SELECT mode FROM score_term_settings WHERE class_id=? AND term_id=?',
  ).get(classId, termId) as { mode: string } | undefined;
  const exams = conn.prepare(
    `SELECT * FROM score_exams WHERE class_id=? AND term_id=?
     ORDER BY enabled DESC, CASE WHEN exam_date='' THEN 1 ELSE 0 END,
              exam_date, sort_order, id`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const links = conn.prepare(
    `SELECT es.exam_id, es.subject_id FROM score_exam_subjects es
     JOIN score_exams e ON e.id=es.exam_id
     WHERE e.class_id=? AND e.term_id=? ORDER BY es.sort_order, es.subject_id`,
  ).all(classId, termId) as Array<{ exam_id: number; subject_id: number }>;
  const byExam = new Map<number, number[]>();
  for (const row of links) {
    const examId = Number(row.exam_id);
    if (!byExam.has(examId)) byExam.set(examId, []);
    byExam.get(examId)!.push(Number(row.subject_id));
  }
  for (const item of subjects) item.enabled = Boolean(item.enabled);
  const examItems = exams.map((item) => ({
    ...item,
    enabled: Boolean(item.enabled),
    subject_ids: byExam.get(Number(item.id)) ?? [],
  }));
  const mode = settingsRow ? settingsRow.mode : '固定科目';
  return {
    exams: examItems, subjects,
    settings: { mode },
    sichuan_312: sichuan312Config(subjects, mode),
  };
}

export function applySichuan312Preset(options: { conn?: Database } = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const existing = conn.prepare(
    'SELECT * FROM score_subjects WHERE class_id=? AND term_id=? ORDER BY id',
  ).all(classId, termId) as Array<Record<string, unknown>>;
  conn.transaction(() => {
    SICHUAN_312_SUBJECTS.forEach((expected, index) => {
      const sortOrder = index + 1;
      const subject = existing.find(
        (item) => canonicalSubjectName(String(item.name ?? '')) === expected.name,
      );
      if (subject) {
        conn.prepare(
          `UPDATE score_subjects SET enabled=1, sort_order=?, subject_group=?,
             score_type=?, updated_at=datetime('now','localtime') WHERE id=?`,
        ).run(sortOrder, expected.group, expected.score_type, Number(subject.id));
      } else {
        conn.prepare(
          `INSERT INTO score_subjects(
             class_id, term_id, name, full_score, sort_order, enabled,
             subject_group, score_type
           ) VALUES(?,?,?,?,?,1,?,?)`,
        ).run(classId, termId, expected.name, expected.full_score, sortOrder,
          expected.group, expected.score_type);
      }
    });
    conn.prepare(
      `INSERT INTO score_term_settings(class_id, term_id, mode)
       VALUES(?,?,'3+1+2')
       ON CONFLICT(class_id, term_id) DO UPDATE SET mode='3+1+2',
       updated_at=datetime('now','localtime')`,
    ).run(classId, termId);
    audit.record('score_term_settings', termId, 'update', {
      summary: '应用四川3+1+2标准科目配置',
      params: { mode: '3+1+2' }, classId, termId, conn,
    });
  })();
  return { ok: true, config: listConfig({ conn }) };
}

export function subjectRow(
  subjectId: number, options: { write?: boolean; conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    'SELECT * FROM score_subjects WHERE id=? AND class_id=? AND term_id=?',
  ).get(Number(subjectId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ScoreError('科目配置不存在');
  return row;
}

function examRow(
  examId: number, options: { write?: boolean; conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: options.write, conn });
  const row = conn.prepare(
    'SELECT * FROM score_exams WHERE id=? AND class_id=? AND term_id=?',
  ).get(Number(examId), classId, termId) as Record<string, unknown> | undefined;
  if (!row) throw new ScoreError('考试配置不存在');
  return row;
}

function replaceExamSubjects(examId: number, subjectIds: unknown[], conn: Database): void {
  const cleanIds: number[] = [];
  for (const subjectId of subjectIds) {
    const subject = subjectRow(Number(subjectId), { write: true, conn });
    if (subject.enabled && !cleanIds.includes(Number(subject.id))) {
      cleanIds.push(Number(subject.id));
    }
  }
  conn.prepare('DELETE FROM score_exam_subjects WHERE exam_id=?').run(examId);
  const stmt = conn.prepare(
    'INSERT INTO score_exam_subjects(exam_id, subject_id, sort_order) VALUES(?,?,?)',
  );
  cleanIds.forEach((subjectId, index) => stmt.run(examId, subjectId, index));
}

export function createSubject(options: {
  name?: unknown; fullScore?: unknown; enabled?: boolean; sortOrder?: unknown;
  subjectGroup?: string; scoreType?: string; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const name = text(options.name);
  if (!name) throw new ScoreError('科目名称不能为空');
  const subjectGroup = options.subjectGroup ?? '必考';
  if (!SUBJECT_GROUPS.has(subjectGroup)) throw new ScoreError('科目分组不合法');
  const scoreType = options.scoreType ?? '原始分';
  if (!SCORE_TYPES.has(scoreType)) throw new ScoreError('成绩口径不合法');
  const fullScore = positiveNumber(options.fullScore ?? 0, '满分');
  const enabled = options.enabled ?? true;
  const sortOrder = options.sortOrder ?? 0;
  const [classId, termId] = scopeIds({ write: true, conn });
  let subjectId: number;
  try {
    subjectId = conn.transaction(() => {
      const inserted = conn.prepare(
        `INSERT INTO score_subjects(
           class_id, term_id, name, full_score, sort_order, enabled,
           subject_group, score_type
         ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(classId, termId, name, fullScore, Number(sortOrder), enabled ? 1 : 0,
        subjectGroup, scoreType);
      const id = Number(inserted.lastInsertRowid);
      audit.record('score_subject', id, 'create', {
        summary: `新增成绩科目：${name}`,
        params: { name, full_score: fullScore, subject_group: subjectGroup, score_type: scoreType },
        classId, termId, conn,
      });
      return id;
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) {
      throw new ScoreError('当前学期已存在同名科目');
    }
    throw error;
  }
  return { ok: true, subject_id: subjectId };
}

export function updateSubject(subjectId: number, options: {
  name?: unknown; fullScore?: unknown; enabled?: boolean | null; sortOrder?: unknown;
  subjectGroup?: string | null; scoreType?: string | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const current = subjectRow(Number(subjectId), { write: true, conn });
  const values: Record<string, unknown> = {
    name: options.name !== undefined && options.name !== null ? text(options.name) : current.name,
    full_score: options.fullScore !== undefined && options.fullScore !== null
      ? positiveNumber(options.fullScore, '满分') : current.full_score,
    enabled: options.enabled !== undefined && options.enabled !== null
      ? (options.enabled ? 1 : 0) : current.enabled,
    sort_order: options.sortOrder !== undefined && options.sortOrder !== null
      ? Number(options.sortOrder) : current.sort_order,
    subject_group: options.subjectGroup !== undefined && options.subjectGroup !== null
      ? String(options.subjectGroup) : String(current.subject_group ?? '必考'),
    score_type: options.scoreType !== undefined && options.scoreType !== null
      ? String(options.scoreType) : String(current.score_type ?? '原始分'),
  };
  if (!text(values.name)) throw new ScoreError('科目名称不能为空');
  if (!SUBJECT_GROUPS.has(String(values.subject_group))) throw new ScoreError('科目分组不合法');
  if (!SCORE_TYPES.has(String(values.score_type))) throw new ScoreError('成绩口径不合法');
  const settingsRow = conn.prepare(
    'SELECT mode FROM score_term_settings WHERE class_id=? AND term_id=?',
  ).get(Number(current.class_id), Number(current.term_id)) as { mode: string } | undefined;
  const expected = sichuanExpectedSubject(String(current.name ?? ''));
  if (settingsRow && settingsRow.mode === '3+1+2' && expected) {
    if (!values.enabled) throw new ScoreError('四川3+1+2标准科目不能停用');
    if (canonicalSubjectName(String(values.name)) !== expected.name) {
      throw new ScoreError('四川3+1+2标准科目不能改为其他科目');
    }
    if (String(values.subject_group) !== expected.group
      || String(values.score_type) !== expected.score_type) {
      throw new ScoreError('四川3+1+2标准科目的分组和成绩口径由系统维护');
    }
  }
  const [classId, termId] = scopeIds({ write: true, conn });
  try {
    conn.transaction(() => {
      conn.prepare(
        `UPDATE score_subjects SET name=?, full_score=?, enabled=?, sort_order=?,
           subject_group=?, score_type=?, updated_at=datetime('now','localtime') WHERE id=?`,
      ).run(values.name, values.full_score, values.enabled, values.sort_order,
        values.subject_group, values.score_type, Number(subjectId));
      if (String(values.name) !== String(current.name)) {
        conn.prepare(
          `UPDATE exam_records SET subject=?, updated_at=datetime('now','localtime')
           WHERE subject_id=? AND deleted_at=''`,
        ).run(String(values.name), Number(subjectId));
      }
      audit.record('score_subject', Number(subjectId), 'update', {
        summary: `更新成绩科目：${String(values.name)}`,
        params: values, classId, termId, conn,
      });
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) {
      throw new ScoreError('当前学期已存在同名科目');
    }
    throw error;
  }
  return { ok: true };
}

export function updateTermSettings(options: { mode?: string; conn?: Database } = {}): Record<string, unknown> {
  const mode = String(options.mode ?? '');
  if (!SCORE_MODES.has(mode)) throw new ScoreError('选科模式不合法');
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  conn.transaction(() => {
    conn.prepare(
      `INSERT INTO score_term_settings(class_id, term_id, mode)
       VALUES(?,?,?)
       ON CONFLICT(class_id, term_id) DO UPDATE SET mode=excluded.mode,
       updated_at=datetime('now','localtime')`,
    ).run(classId, termId, mode);
    audit.record('score_term_settings', termId, 'update', {
      summary: `更新成绩选科模式：${mode}`,
      params: { mode }, classId, termId, conn,
    });
  })();
  return { ok: true, mode };
}

function replaceStudentSubjectSelection(
  studentId: number, subjectIds: number[],
  options: { classId: number; termId: number; conn: Database },
): void {
  const { classId, termId, conn } = options;
  conn.prepare(
    `INSERT INTO student_score_profiles(class_id, term_id, student_id)
     VALUES(?,?,?)
     ON CONFLICT(class_id, term_id, student_id) DO UPDATE SET
     updated_at=datetime('now','localtime')`,
  ).run(classId, termId, studentId);
  conn.prepare(
    'DELETE FROM student_score_subjects WHERE class_id=? AND term_id=? AND student_id=?',
  ).run(classId, termId, studentId);
  const stmt = conn.prepare(
    `INSERT INTO student_score_subjects(
       class_id, term_id, student_id, subject_id
     ) VALUES(?,?,?,?)`,
  );
  for (const subjectId of subjectIds) stmt.run(classId, termId, studentId, subjectId);
}

export function saveStudentSubjects(
  studentId: number, subjectIds: unknown[], options: { conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const student = conn.prepare(
    `SELECT s.id FROM students s JOIN student_enrollments e ON e.student_id=s.id
     WHERE s.id=? AND e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''`,
  ).get(Number(studentId), classId, termId) as { id: number } | undefined;
  if (!student) throw new ScoreError('学生不在当前班级和学期');
  const cleanIds: number[] = [];
  for (const subjectId of subjectIds ?? []) {
    const subject = subjectRow(Number(subjectId), { write: true, conn });
    if (!subject.enabled) throw new ScoreError('不能选择已停用科目');
    if (!cleanIds.includes(Number(subject.id))) cleanIds.push(Number(subject.id));
  }
  const modeRow = conn.prepare(
    'SELECT mode FROM score_term_settings WHERE class_id=? AND term_id=?',
  ).get(classId, termId) as { mode: string } | undefined;
  const mode = modeRow ? modeRow.mode : '固定科目';
  const subjectById = new Map<number, Record<string, unknown>>();
  for (const row of conn.prepare(
    'SELECT * FROM score_subjects WHERE class_id=? AND term_id=?',
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    subjectById.set(Number(row.id), row);
  }
  const error = selectionError(mode, new Set(cleanIds), subjectById);
  if (error) throw new ScoreError(error);
  conn.transaction(() => {
    replaceStudentSubjectSelection(Number(studentId), cleanIds, { classId, termId, conn });
    audit.record('student_score_subjects', Number(studentId), 'update', {
      summary: '更新学生选科',
      params: { student_id: Number(studentId), subject_ids: cleanIds },
      classId, termId, conn,
    });
  })();
  return { ok: true, student_id: Number(studentId), subject_ids: cleanIds };
}

export function saveStudentSubjectsBatch(
  studentIds: unknown[], subjectIds: unknown[], options: { conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ write: true, conn });
  const cleanStudentIds: number[] = [];
  const seenStudents = new Set<number>();
  for (const value of studentIds ?? []) {
    const id = Number(value);
    if (!seenStudents.has(id)) {
      seenStudents.add(id);
      cleanStudentIds.push(id);
    }
  }
  if (cleanStudentIds.length === 0) throw new ScoreError('请至少选择一名学生');
  const placeholders = cleanStudentIds.map(() => '?').join(',');
  const rows = conn.prepare(
    `SELECT s.id FROM students s JOIN student_enrollments e ON e.student_id=s.id
     WHERE s.id IN (${placeholders}) AND e.class_id=? AND e.term_id=?
       AND e.status='在读' AND s.deleted_at=''`,
  ).all(...cleanStudentIds, classId, termId) as Array<{ id: number }>;
  const found = new Set(rows.map((row) => Number(row.id)));
  if (cleanStudentIds.some((id) => !found.has(id)) || found.size !== cleanStudentIds.length) {
    throw new ScoreError('部分学生不在当前班级和学期');
  }
  const cleanSubjectIds: number[] = [];
  const seenSubjects = new Set<number>();
  for (const value of subjectIds ?? []) {
    const id = Number(value);
    if (!seenSubjects.has(id)) {
      seenSubjects.add(id);
      cleanSubjectIds.push(id);
    }
  }
  const subjectById = new Map<number, Record<string, unknown>>();
  for (const row of conn.prepare(
    'SELECT * FROM score_subjects WHERE class_id=? AND term_id=?',
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    subjectById.set(Number(row.id), row);
  }
  if (cleanSubjectIds.some((value) => !subjectById.has(value) || !subjectById.get(value)!.enabled)) {
    throw new ScoreError('选科中包含不存在或已停用的科目');
  }
  const modeRow = conn.prepare(
    'SELECT mode FROM score_term_settings WHERE class_id=? AND term_id=?',
  ).get(classId, termId) as { mode: string } | undefined;
  const mode = modeRow ? modeRow.mode : '固定科目';
  const error = selectionError(mode, new Set(cleanSubjectIds), subjectById);
  if (error) throw new ScoreError(error);
  conn.transaction(() => {
    for (const studentId of cleanStudentIds) {
      replaceStudentSubjectSelection(studentId, cleanSubjectIds, { classId, termId, conn });
    }
    audit.record('student_score_subjects', termId, 'batch_update', {
      summary: '批量更新学生选科',
      params: { student_ids: cleanStudentIds, subject_ids: cleanSubjectIds },
      classId, termId, conn,
    });
  })();
  return {
    ok: true, updated_count: cleanStudentIds.length,
    student_ids: cleanStudentIds, subject_ids: cleanSubjectIds,
  };
}

export function createExam(options: {
  name?: unknown; examDate?: unknown; subjectIds?: unknown[] | null; enabled?: boolean;
  sortOrder?: unknown; fullScore?: unknown; remark?: unknown; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const name = text(options.name);
  if (!name) throw new ScoreError('考试名称不能为空');
  const examDate = dateText(options.examDate);
  const enabled = options.enabled ?? true;
  const sortOrder = options.sortOrder ?? 0;
  const fullScore = options.fullScore === undefined || options.fullScore === null || text(options.fullScore) === ''
    ? 0 : positiveNumber(options.fullScore, '考试满分');
  const remark = text(options.remark);
  const [classId, termId] = scopeIds({ write: true, conn });
  let examId: number;
  try {
    examId = conn.transaction(() => {
      const inserted = conn.prepare(
        `INSERT INTO score_exams(
           class_id, term_id, name, exam_date, full_score, remark, sort_order, enabled
         ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(classId, termId, name, examDate, fullScore, remark, Number(sortOrder), enabled ? 1 : 0);
      const id = Number(inserted.lastInsertRowid);
      replaceExamSubjects(id, options.subjectIds ?? [], conn);
      audit.record('score_exam', id, 'create', {
        summary: `新增考试：${name}`,
        params: { name, exam_date: examDate, full_score: fullScore, remark, subject_ids: options.subjectIds ?? [] },
        classId, termId, conn,
      });
      return id;
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) {
      throw new ScoreError('当前学期已存在同名考试');
    }
    throw error;
  }
  return { ok: true, exam_id: examId };
}

export function updateExam(examId: number, options: {
  name?: unknown; examDate?: unknown; subjectIds?: unknown[] | null; enabled?: boolean | null;
  sortOrder?: unknown; fullScore?: unknown; remark?: unknown; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const current = examRow(Number(examId), { write: true, conn });
  const values: Record<string, unknown> = {
    name: options.name !== undefined && options.name !== null ? text(options.name) : current.name,
    exam_date: options.examDate !== undefined && options.examDate !== null
      ? dateText(options.examDate) : current.exam_date,
    enabled: options.enabled !== undefined && options.enabled !== null
      ? (options.enabled ? 1 : 0) : current.enabled,
    sort_order: options.sortOrder !== undefined && options.sortOrder !== null
      ? Number(options.sortOrder) : current.sort_order,
    full_score: options.fullScore !== undefined && options.fullScore !== null
      ? positiveNumber(options.fullScore, '考试满分') : Number(current.full_score ?? 0),
    remark: options.remark !== undefined && options.remark !== null
      ? text(options.remark) : String(current.remark ?? ''),
  };
  if (!text(values.name)) throw new ScoreError('考试名称不能为空');
  const [classId, termId] = scopeIds({ write: true, conn });
  try {
    conn.transaction(() => {
      conn.prepare(
        `UPDATE score_exams SET name=?, exam_date=?, full_score=?, remark=?, enabled=?, sort_order=?,
           updated_at=datetime('now','localtime') WHERE id=?`,
      ).run(values.name, values.exam_date, values.full_score, values.remark,
        values.enabled, values.sort_order, Number(examId));
      conn.prepare(
        `UPDATE exam_records SET exam_name=?, exam_date=?,
           updated_at=datetime('now','localtime')
         WHERE exam_id=? AND deleted_at=''`,
      ).run(values.name, values.exam_date, Number(examId));
      if (options.subjectIds !== undefined && options.subjectIds !== null) {
        replaceExamSubjects(Number(examId), options.subjectIds, conn);
      }
      audit.record('score_exam', Number(examId), 'update', {
        summary: `更新考试：${String(values.name)}`,
        params: {
          ...values,
          subject_ids: options.subjectIds !== undefined && options.subjectIds !== null
            ? options.subjectIds : null,
        },
        classId, termId, conn,
      });
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) {
      throw new ScoreError('当前学期已存在同名考试');
    }
    throw error;
  }
  return { ok: true };
}

function parseRank(value: unknown): number | null {
  const rankText = text(value);
  if (!rankText) return null;
  const rank = Math.trunc(Number(rankText));
  if (Number.isNaN(rank)) throw new ScoreError('排名必须是正整数');
  if (rank < 1) throw new ScoreError('排名必须是正整数');
  return rank;
}

function parseScore(value: unknown, explicitStatus: unknown = ''): [number | null, string] {
  const raw = text(value);
  let status = text(explicitStatus) || '正常';
  if (raw === '缺考' || raw === '免考') status = raw;
  if (!RECORD_STATUSES.has(status)) throw new ScoreError('成绩状态仅支持正常、缺考、免考');
  if (status !== '正常') return [null, status];
  if (!raw) throw new ScoreError('正常成绩的分数不能为空');
  return [positiveNumber(raw, '分数'), status];
}

function tripleKey(a: unknown, b: unknown, c: unknown): string {
  return JSON.stringify([a, b, c]);
}

export interface ExamPreviewResult {
  rows: Array<Record<string, unknown>>;
  errors: Array<{ row: number; message: string }>;
  summary: {
    valid: number; new: number; update: number; skip: number; error: number;
    new_exams: number; new_subjects: number;
  };
  duplicate_strategy: string;
  format: string;
}

export function previewExamRows(rows: unknown[][], duplicateStrategy = 'update'): ExamPreviewResult {
  if (!DUPLICATE_STRATEGIES.has(duplicateStrategy)) throw new ScoreError('重复记录策略不合法');
  if (!rows || rows.length === 0) throw new ScoreError('Excel 没有数据');
  const headers = rows[0].map((value) => text(value));
  const present = headers.filter((item) => item);
  if (present.length !== new Set(present).size) throw new ScoreError('Excel 表头存在重复列');
  const index: Record<string, number> = {};
  headers.forEach((value, position) => {
    if (value) index[value] = position;
  });
  if (!('学号' in index) || !('考试名称' in index)) {
    throw new ScoreError('成绩表必须包含：学号、考试名称');
  }
  const longFormat = '科目' in index && '分数' in index;
  const metadata = new Set(['学号', '姓名', '考试名称', '考试日期', '科目', '分数', '排名', '状态', '备注']);
  const wideSubjects = headers.filter((header) => header && !metadata.has(header));
  if (!longFormat && wideSubjects.length === 0) {
    throw new ScoreError('成绩表需要科目列，或包含“科目、分数”列');
  }

  const conn = getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const students = new Map<string, Record<string, unknown>>();
  for (const row of conn.prepare(
    `SELECT s.id, s.学号, s.姓名 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''`,
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    students.set(String(row['学号'] ?? '').trim(), row);
  }
  const exams = new Map<string, Record<string, unknown>>();
  for (const row of conn.prepare(
    'SELECT * FROM score_exams WHERE class_id=? AND term_id=?',
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    exams.set(String(row.name), row);
  }
  const subjects = new Map<string, Record<string, unknown>>();
  for (const row of conn.prepare(
    'SELECT * FROM score_subjects WHERE class_id=? AND term_id=?',
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    subjects.set(String(row.name), row);
  }
  const existing = new Map<string, Record<string, unknown>>();
  for (const row of conn.prepare(
    `SELECT id, student_id, exam_name, subject, deleted_at FROM exam_records
     WHERE class_id=? AND term_id=?`,
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    existing.set(tripleKey(Number(row.student_id), String(row.exam_name), String(row.subject)), row);
  }

  const output: Array<Record<string, unknown>> = [];
  const errors: Array<{ row: number; message: string }> = [];
  const seen = new Set<string>();

  const cell = (values: unknown[], key: string): unknown => {
    const position = index[key];
    return position !== undefined && position < values.length ? values[position] : null;
  };

  const appendItem = (
    rowNo: number, values: unknown[], subjectName: unknown, rawScore: unknown,
    explicitStatus: unknown = '', rankValue: unknown = null,
  ): void => {
    const studentNo = text(cell(values, '学号'));
    const student = students.get(studentNo);
    const examName = text(cell(values, '考试名称'));
    const subjectNameText = text(subjectName);
    try {
      const examDate = '考试日期' in index ? dateText(cell(values, '考试日期')) : '';
      if (!studentNo) throw new ScoreError('学号不能为空');
      if (!student) throw new ScoreError(`找不到当前班级学生：${studentNo}`);
      if (!examName) throw new ScoreError('考试名称不能为空');
      if (!subjectNameText) throw new ScoreError('科目不能为空');
      const configuredExam = exams.get(examName);
      if (configuredExam && configuredExam.exam_date && examDate
        && String(configuredExam.exam_date) !== examDate) {
        throw new ScoreError(`考试日期与配置不一致：${configuredExam.exam_date}`);
      }
      const [score, recordStatus] = parseScore(rawScore, explicitStatus);
      const rank = parseRank(rankValue);
      const subject = subjects.get(subjectNameText);
      if (score !== null && subject && Number(subject.full_score ?? 0) > 0
        && score > Number(subject.full_score)) {
        throw new ScoreError(`分数超过科目满分 ${formatG(Number(subject.full_score))}`);
      }
      const key = tripleKey(Number(student.id), examName, subjectNameText);
      if (seen.has(key)) throw new ScoreError('文件内存在重复的学生、考试和科目');
      seen.add(key);
      const old = existing.get(key);
      if (old && String(old.deleted_at)) throw new ScoreError('该成绩位于回收站，请先恢复或永久删除');
      const action = !old ? '新增' : (duplicateStrategy === 'update' ? '更新' : '跳过');
      output.push({
        row: rowNo, valid: true, student_id: Number(student.id),
        学号: studentNo, 姓名: student['姓名'], exam_name: examName,
        exam_date: examDate || (configuredExam ? String(configuredExam.exam_date ?? '') : ''),
        subject: subjectNameText, score, rank, record_status: recordStatus,
        note: text(cell(values, '备注')), action, new_exam: !configuredExam,
        new_subject: !subject, error: '',
      });
    } catch (error) {
      if (!(error instanceof ScoreError)) throw error;
      errors.push({ row: rowNo, message: error.message });
      output.push({
        row: rowNo, valid: false, 学号: studentNo,
        姓名: student ? student['姓名'] : text(cell(values, '姓名')),
        exam_name: examName, exam_date: text(cell(values, '考试日期')),
        subject: subjectNameText, score: text(rawScore), rank: text(rankValue),
        record_status: text(explicitStatus) || '正常', note: text(cell(values, '备注')),
        action: '错误', new_exam: false, new_subject: false, error: error.message,
      });
    }
  };

  for (let position = 1; position < rows.length; position += 1) {
    const values = rows[position];
    const rowNo = position + 1;
    if (!values.some((value) => value !== null && value !== undefined && value !== '')) continue;
    if (longFormat) {
      appendItem(
        rowNo, values, cell(values, '科目'), cell(values, '分数'),
        '状态' in index ? cell(values, '状态') : '',
        '排名' in index ? cell(values, '排名') : null,
      );
    } else {
      let produced = false;
      for (const subjectName of wideSubjects) {
        const raw = cell(values, subjectName);
        if (raw === null || raw === undefined || raw === '') continue;
        produced = true;
        appendItem(rowNo, values, subjectName, raw);
      }
      if (!produced) {
        errors.push({ row: rowNo, message: '该行没有任何科目成绩' });
        output.push({
          row: rowNo, valid: false, 学号: text(cell(values, '学号')),
          姓名: text(cell(values, '姓名')), exam_name: text(cell(values, '考试名称')),
          exam_date: text(cell(values, '考试日期')), subject: '', score: '',
          rank: '', record_status: '正常', note: text(cell(values, '备注')),
          action: '错误', new_exam: false, new_subject: false,
          error: '该行没有任何科目成绩',
        });
      }
    }
  }

  const valid = output.filter((item) => item.valid === true);
  return {
    rows: output, errors,
    summary: {
      valid: valid.length, new: valid.filter((item) => item.action === '新增').length,
      update: valid.filter((item) => item.action === '更新').length,
      skip: valid.filter((item) => item.action === '跳过').length,
      error: errors.length,
      new_exams: new Set(valid.filter((item) => item.new_exam)
        .map((item) => String(item.exam_name))).size,
      new_subjects: new Set(valid.filter((item) => item.new_subject)
        .map((item) => String(item.subject))).size,
    },
    duplicate_strategy: duplicateStrategy,
    format: longFormat ? 'long' : 'wide',
  };
}

function ensureExam(name: string, examDate: string, conn: Database): Record<string, unknown> {
  const [classId, termId] = scopeIds({ write: true, conn });
  const row = conn.prepare(
    'SELECT * FROM score_exams WHERE class_id=? AND term_id=? AND name=?',
  ).get(classId, termId, name) as Record<string, unknown> | undefined;
  if (row) {
    if (row.exam_date && examDate && String(row.exam_date) !== examDate) {
      throw new ScoreError(`考试“${name}”日期与配置不一致`);
    }
    if (!row.exam_date && examDate) {
      conn.prepare(
        `UPDATE score_exams SET exam_date=?, updated_at=datetime('now','localtime') WHERE id=?`,
      ).run(examDate, Number(row.id));
      row.exam_date = examDate;
    }
    return row;
  }
  const inserted = conn.prepare(
    `INSERT INTO score_exams(class_id, term_id, name, exam_date, sort_order)
     VALUES(?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM score_exams
                             WHERE class_id=? AND term_id=?),0))`,
  ).run(classId, termId, name, examDate, classId, termId);
  return { id: Number(inserted.lastInsertRowid), name, exam_date: examDate };
}

function ensureSubject(name: string, conn: Database): Record<string, unknown> {
  const [classId, termId] = scopeIds({ write: true, conn });
  const row = conn.prepare(
    'SELECT * FROM score_subjects WHERE class_id=? AND term_id=? AND name=?',
  ).get(classId, termId, name) as Record<string, unknown> | undefined;
  if (row) return row;
  const inserted = conn.prepare(
    `INSERT INTO score_subjects(class_id, term_id, name, sort_order)
     VALUES(?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM score_subjects
                            WHERE class_id=? AND term_id=?),0))`,
  ).run(classId, termId, name, classId, termId);
  return { id: Number(inserted.lastInsertRowid), name, full_score: 0 };
}

export function commitExamRows(
  rows: Array<Record<string, unknown>>,
  options: { filename?: string; duplicateStrategy?: string; requestId?: string; conn?: Database } = {},
): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const duplicateStrategy = options.duplicateStrategy ?? 'update';
  if (!DUPLICATE_STRATEGIES.has(duplicateStrategy)) throw new ScoreError('重复记录策略不合法');
  const validRows = rows
    .filter((item) => (item.valid === undefined ? true : Boolean(item.valid)))
    .map((item) => ({ ...item }));
  if (validRows.length === 0) throw new ScoreError('没有可提交的成绩');
  const [classId, termId] = scopeIds({ write: true, conn });
  const requestId = text(options.requestId);
  if (requestId) {
    const existingRun = conn.prepare(
      `SELECT result_json FROM score_import_runs
       WHERE class_id=? AND term_id=? AND request_id=?`,
    ).get(classId, termId, requestId) as { result_json?: string } | undefined;
    if (existingRun) {
      const stored = JSON.parse(existingRun.result_json ?? '{}') as Record<string, unknown>;
      return { ...stored, idempotent: true };
    }
  }

  const students = new Map<number, Record<string, unknown>>();
  for (const row of conn.prepare(
    `SELECT s.id, s.学号, s.姓名 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''`,
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    students.set(Number(row.id), row);
  }
  const cleanRows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (let index = 0; index < validRows.length; index += 1) {
    const item = validRows[index];
    const position = index + 1;
    try {
      const studentId = Number(item.student_id ?? 0);
      if (!students.has(studentId)) throw new ScoreError('学生不在当前班级和学期');
      const examName = text(item.exam_name);
      const subjectName = text(item.subject);
      if (!examName || !subjectName) throw new ScoreError('考试名称和科目不能为空');
      const examDate = dateText(item.exam_date);
      const recordStatus = text(item.record_status) || '正常';
      if (!RECORD_STATUSES.has(recordStatus)) throw new ScoreError('成绩状态不合法');
      const scoreValue = item.score;
      let score: number | null;
      if (recordStatus === '正常') {
        if (scoreValue === null || scoreValue === undefined || scoreValue === '') {
          throw new ScoreError('正常成绩的分数不能为空');
        }
        score = positiveNumber(scoreValue, '分数');
      } else {
        score = null;
      }
      const rank = parseRank(item.rank);
      const key = tripleKey(studentId, examName, subjectName);
      if (seen.has(key)) throw new ScoreError('提交内容包含重复的学生、考试和科目');
      seen.add(key);
      cleanRows.push({
        student_id: studentId, exam_name: examName, exam_date: examDate,
        subject: subjectName, score, rank, record_status: recordStatus,
        note: text(item.note),
      });
    } catch (error) {
      if (error instanceof ScoreError) {
        throw new ScoreError(`第 ${item.row ?? position} 行：${error.message}`);
      }
      throw error;
    }
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let runId: number;
  try {
    runId = conn.transaction(() => {
      const inserted = conn.prepare(
        `INSERT INTO score_import_runs(
           class_id, term_id, request_id, filename, duplicate_strategy
         ) VALUES(?,?,?,?,?)`,
      ).run(classId, termId, requestId, text(options.filename), duplicateStrategy);
      const runIdValue = Number(inserted.lastInsertRowid);
      for (const item of cleanRows) {
        const exam = ensureExam(String(item.exam_name), String(item.exam_date), conn);
        const subject = ensureSubject(String(item.subject), conn);
        if (item.score !== null && Number(subject.full_score ?? 0) > 0
          && Number(item.score) > Number(subject.full_score)) {
          throw new ScoreError(
            `${item.subject}分数超过满分 ${formatG(Number(subject.full_score))}`);
        }
        conn.prepare(
          `INSERT OR IGNORE INTO score_exam_subjects(exam_id, subject_id, sort_order)
           VALUES(?,?,COALESCE((SELECT MAX(sort_order)+1 FROM score_exam_subjects
                               WHERE exam_id=?),0))`,
        ).run(Number(exam.id), Number(subject.id), Number(exam.id));
        const existing = conn.prepare(
          `SELECT id, deleted_at FROM exam_records
           WHERE student_id=? AND class_id=? AND term_id=?
             AND exam_name=? AND subject=?`,
        ).get(Number(item.student_id), classId, termId,
          String(item.exam_name), String(item.subject)) as
          { id: number; deleted_at: string } | undefined;
        if (existing && existing.deleted_at) {
          throw new ScoreError(
            `${item.exam_name} · ${item.subject}成绩位于回收站，请先处理`);
        }
        if (existing && duplicateStrategy === 'skip') {
          skipped += 1;
          continue;
        }
        if (existing) {
          conn.prepare(
            `UPDATE exam_records SET exam_id=?, subject_id=?, exam_date=?,
               score=?, rank=?, record_status=?, note=?, import_run_id=?,
               updated_at=datetime('now','localtime') WHERE id=?`,
          ).run(Number(exam.id), Number(subject.id), String(exam.exam_date),
            item.score, item.rank, String(item.record_status), String(item.note),
            runIdValue, existing.id);
          updated += 1;
        } else {
          conn.prepare(
            `INSERT INTO exam_records(
               student_id, class_id, term_id, exam_id, subject_id,
               exam_name, exam_date, subject, score, rank,
               record_status, note, import_run_id
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(Number(item.student_id), classId, termId, Number(exam.id), Number(subject.id),
            String(exam.name), String(exam.exam_date), String(subject.name), item.score,
            item.rank, String(item.record_status), String(item.note), runIdValue);
          imported += 1;
        }
      }
      const resultValue = {
        ok: true, run_id: runIdValue, imported, updated, skipped, errors: [], idempotent: false,
      };
      conn.prepare(
        `UPDATE score_import_runs SET imported=?, updated=?, skipped=?,
           result_json=? WHERE id=?`,
      ).run(imported, updated, skipped, JSON.stringify(resultValue), runIdValue);
      audit.record('score_import', runIdValue, 'import', {
        summary: `导入成绩：新增 ${imported}，更新 ${updated}，跳过 ${skipped}`,
        params: { filename: options.filename, duplicate_strategy: duplicateStrategy,
          rows: cleanRows.length },
        classId, termId, conn,
      });
      return runIdValue;
    })();
  } catch (error) {
    throw error;
  }
  const result: Record<string, unknown> = {
    ok: true, run_id: runId, imported, updated, skipped, errors: [], idempotent: false,
  };
  try {
    const evaluation = rulesModule.evaluateRules({ trigger: 'import', conn });
    result.evaluation = evaluation;
    result.evaluation_error = '';
  } catch (error) {
    result.evaluation = null;
    result.evaluation_error = String((error as Error).message);
  }
  return result;
}

export function importExamRows(rows: unknown[][], duplicateStrategy = 'update'): Record<string, unknown> {
  const preview = previewExamRows(rows, duplicateStrategy);
  const valid = preview.rows.filter((item) => item.valid === true && item.action !== '跳过');
  if (valid.length === 0) {
    return {
      imported: 0, updated: 0, skipped: preview.summary.skip,
      errors: preview.errors.map((item) => item.message),
    };
  }
  const result = commitExamRows(valid, {
    filename: '兼容导入', duplicateStrategy,
    requestId: `compat-${randomUUID().replace(/-/g, '')}`,
  });
  result.errors = preview.errors.map((item) => `第 ${item.row} 行：${item.message}`);
  return result;
}

export function listRecords(options: {
  studentId?: number | null; examId?: number | null; conn?: Database;
} = {}): Array<Record<string, unknown>> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const where = ["r.class_id=?", "r.term_id=?", "r.deleted_at=''", "s.deleted_at=''"];
  const params: unknown[] = [classId, termId];
  if (options.studentId) {
    where.push('r.student_id=?');
    params.push(Number(options.studentId));
  }
  if (options.examId) {
    where.push('r.exam_id=?');
    params.push(Number(options.examId));
  }
  return conn.prepare(
    `SELECT r.*, s.学号, s.姓名,
            COALESCE(x.name, r.exam_name) AS configured_exam_name,
            COALESCE(x.exam_date, r.exam_date) AS configured_exam_date,
            COALESCE(j.name, r.subject) AS configured_subject_name
     FROM exam_records r JOIN students s ON s.id=r.student_id
     LEFT JOIN score_exams x ON x.id=r.exam_id
     LEFT JOIN score_subjects j ON j.id=r.subject_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(x.exam_date, r.exam_date), COALESCE(x.sort_order, r.id),
              s.学号, COALESCE(j.sort_order, r.id), r.id`,
  ).all(...params) as Array<Record<string, unknown>>;
}

export function scoreSummary(options: {
  studentId?: number | null; conn?: Database;
} = {}): Record<string, unknown> {
  const conn = options.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const config = listConfig({ conn });
  const settings = config.settings as Record<string, unknown> | undefined;
  const selectionMode = String(settings?.mode ?? '固定科目');
  const exams = (config.exams as Array<Record<string, unknown>>).filter((item) => item.enabled);
  const subjects = (config.subjects as Array<Record<string, unknown>>).filter((item) => item.enabled);
  const records = listRecords({ conn });
  const students = conn.prepare(
    `SELECT s.id AS student_id, s.学号, s.姓名 FROM students s
     JOIN student_enrollments e ON e.student_id=s.id
     WHERE e.class_id=? AND e.term_id=? AND e.status='在读' AND s.deleted_at=''
     ORDER BY s.学号`,
  ).all(classId, termId) as Array<Record<string, unknown>>;
  const selectedSubjectsByStudent = new Map<number, Set<number>>();
  for (const row of conn.prepare(
    `SELECT student_id, subject_id FROM student_score_subjects
     WHERE class_id=? AND term_id=? ORDER BY student_id, subject_id`,
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    const studentId = Number(row.student_id);
    if (!selectedSubjectsByStudent.has(studentId)) {
      selectedSubjectsByStudent.set(studentId, new Set());
    }
    selectedSubjectsByStudent.get(studentId)!.add(Number(row.subject_id));
  }
  const configuredSelectionStudents = new Set<number>();
  for (const row of conn.prepare(
    `SELECT student_id FROM student_score_profiles
     WHERE class_id=? AND term_id=?`,
  ).all(classId, termId) as Array<Record<string, unknown>>) {
    configuredSelectionStudents.add(Number(row.student_id));
  }
  if (exams.length === 0 && records.length > 0) {
    const seen = new Set<number>();
    for (const row of records) {
      const key = Number(row.exam_id ?? 0);
      if (key && !seen.has(key)) {
        exams.push({
          id: key, name: row.exam_name, exam_date: row.exam_date,
          subject_ids: [], enabled: true,
        });
        seen.add(key);
      }
    }
  }
  exams.sort((a, b) => {
    const dateA = String(a.exam_date ?? '') || '9999-99-99';
    const dateB = String(b.exam_date ?? '') || '9999-99-99';
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    const sortA = Number(a.sort_order ?? 0);
    const sortB = Number(b.sort_order ?? 0);
    if (sortA !== sortB) return sortA - sortB;
    return Number(a.id) - Number(b.id);
  });
  const subjectById = new Map<number, Record<string, unknown>>();
  for (const item of subjects) subjectById.set(Number(item.id), item);
  const recordsByKey = new Map<string, Record<string, unknown>>();
  for (const row of records) {
    if (row.exam_id && row.subject_id) {
      recordsByKey.set(
        tripleKey(Number(row.student_id), Number(row.exam_id), Number(row.subject_id)), row);
    }
  }
  const recordPairs = new Set<string>();
  for (const row of records) {
    if (row.exam_id && row.subject_id) {
      recordPairs.add(`${Number(row.student_id)}:${Number(row.exam_id)}`);
    }
  }
  const examById = new Map<number, Record<string, unknown>>();
  for (const exam of exams) examById.set(Number(exam.id), exam);
  const expectedForExam = (examId: number): number[] => {
    const fromConfig = (examById.get(examId)?.subject_ids as unknown[] ?? [])
      .map((value) => Number(value))
      .filter((value) => subjectById.has(value));
    if (fromConfig.length > 0) return fromConfig;
    const fromRecords = new Set<number>();
    for (const row of records) {
      if (Number(row.exam_id ?? 0) === examId && row.subject_id) {
        fromRecords.add(Number(row.subject_id));
      }
    }
    return [...fromRecords].sort((a, b) =>
      Number(subjectById.get(a)?.sort_order ?? a) - Number(subjectById.get(b)?.sort_order ?? b));
  };

  const studentOutput: Array<Record<string, unknown>> = [];
  const examStudentMap = new Map<number, Array<Record<string, unknown>>>();
  for (const exam of exams) examStudentMap.set(Number(exam.id), []);
  for (const student of students) {
    const studentId = Number(student.student_id);
    const selectedSubjectIds = selectedSubjectsByStudent.get(studentId);
    const selectionConfigured = configuredSelectionStudents.has(studentId);
    const selectionStatusText = selectionConfigured
      ? selectionStatus(selectionMode, selectedSubjectIds ?? new Set<number>(), subjectById)
      : '未配置';
    const selectionValid = !selectionConfigured || selectionStatusText === '有效';
    const examResults: Array<Record<string, unknown>> = [];
    for (const exam of exams) {
      const examId = Number(exam.id);
      const expectedIds = expectedForExam(examId)
        .filter((subjectIdValue) => !selectionConfigured
          || String(subjectById.get(subjectIdValue)?.subject_group ?? '必考') === '必考'
          || (selectedSubjectIds?.has(subjectIdValue) ?? false));
      const detail: Record<string, Record<string, unknown>> = {};
      const missing: string[] = [];
      for (const subjectIdValue of expectedIds) {
        const subject = subjectById.get(subjectIdValue) ?? { name: `科目${subjectIdValue}` };
        const row = recordsByKey.get(tripleKey(studentId, examId, subjectIdValue));
        const value: Record<string, unknown> = {
          subject_id: subjectIdValue, subject: subject.name,
          score: row ? row.score : null,
          status: row ? row.record_status : '未录入',
          note: row ? row.note : '',
        };
        detail[String(subject.name)] = value;
        if (!row || String(row.record_status) !== '正常'
          || row.score === null || row.score === undefined) {
          missing.push(String(subject.name));
        }
      }
      const hasAny = recordPairs.has(`${studentId}:${examId}`);
      const complete = expectedIds.length > 0 && missing.length === 0 && selectionValid;
      let total: number | null = null;
      if (complete) {
        let sum = 0;
        for (const item of Object.values(detail)) sum += Number(item.score);
        total = pyRound(sum, 2);
      }
      const result: Record<string, unknown> = {
        exam_id: examId, exam_name: exam.name, exam_date: exam.exam_date,
        subjects: detail, expected_subject_count: expectedIds.length,
        missing_subjects: missing, complete, has_any: hasAny, total,
        rank: null, stratum: '未分层', total_change: null, rank_change: null,
      };
      examResults.push(result);
      examStudentMap.get(examId)!.push(result);
    }
    studentOutput.push({
      ...student, exams: examResults,
      selected_subject_ids: [...(selectedSubjectIds ?? new Set<number>())].sort((a, b) => a - b),
      selection_configured: selectionConfigured,
      selection_status: selectionStatusText,
    });
  }

  const examOutput: Array<Record<string, unknown>> = [];
  for (const exam of exams) {
    const examId = Number(exam.id);
    const resultRows = examStudentMap.get(examId) ?? [];
    const completeRows = resultRows
      .filter((item) => item.total !== null)
      .sort((a, b) => Number(b.total) - Number(a.total));
    let previousTotal: number | null = null;
    let previousRank = 0;
    const layerSize = completeRows.length > 1
      ? Math.max(1, pyRound(completeRows.length * 0.25)) : 0;
    for (let position = 1; position <= completeRows.length; position += 1) {
      const item = completeRows[position - 1];
      if (previousTotal === null || Number(item.total) !== previousTotal) {
        previousRank = position;
        previousTotal = Number(item.total);
      }
      item.rank = previousRank;
      if (completeRows.length === 1) item.stratum = 'B层';
      else if (position <= layerSize) item.stratum = 'A层';
      else if (position > completeRows.length - layerSize) item.stratum = 'C层';
      else item.stratum = 'B层';
    }
    const subjectStats: Array<Record<string, unknown>> = [];
    for (const subjectIdValue of expectedForExam(examId)) {
      const subject = subjectById.get(subjectIdValue)
        ?? { name: `科目${subjectIdValue}`, full_score: 0 };
      const eligibleStudentIds = new Set<number>();
      for (const item of students) {
        const sid = Number(item.student_id);
        if (!configuredSelectionStudents.has(sid)
          || String(subject.subject_group ?? '必考') === '必考'
          || (selectedSubjectsByStudent.get(sid)?.has(subjectIdValue) ?? false)) {
          eligibleStudentIds.add(sid);
        }
      }
      const values = records.filter((row) =>
        Number(row.exam_id ?? 0) === examId
        && Number(row.subject_id ?? 0) === subjectIdValue
        && eligibleStudentIds.has(Number(row.student_id)));
      const normalScores = values
        .filter((row) => String(row.record_status) === '正常'
          && row.score !== null && row.score !== undefined)
        .map((row) => Number(row.score));
      const explicitAbsence = values.filter((row) => String(row.record_status) === '缺考').length;
      subjectStats.push({
        subject_id: subjectIdValue, subject: subject.name,
        full_score: Number(subject.full_score ?? 0),
        average: normalScores.length > 0
          ? pyRound(normalScores.reduce((sum, score) => sum + score, 0) / normalScores.length, 1)
          : null,
        eligible_count: eligibleStudentIds.size, recorded_count: normalScores.length,
        absent_count: explicitAbsence,
        missing_count: Math.max(0, eligibleStudentIds.size - normalScores.length - explicitAbsence),
      });
    }
    const totals = completeRows.map((item) => Number(item.total));
    examOutput.push({
      ...exam, subject_stats: subjectStats, student_count: students.length,
      complete_count: completeRows.length,
      missing_count: students.length - completeRows.length,
      class_average_total: totals.length > 0
        ? pyRound(totals.reduce((sum, value) => sum + value, 0) / totals.length, 1) : null,
    });
  }

  for (const student of studentOutput) {
    let previous: Record<string, unknown> | null = null;
    for (const item of student.exams as Array<Record<string, unknown>>) {
      if (previous && previous.total !== null && item.total !== null) {
        item.total_change = pyRound(Number(item.total) - Number(previous.total), 2);
        if (previous.rank !== null && item.rank !== null) {
          item.rank_change = Number(previous.rank) - Number(item.rank);
        }
      }
      if (item.total !== null) previous = item;
    }
  }

  const studentId = options.studentId !== undefined && options.studentId !== null
    ? Number(options.studentId) : null;
  const filteredStudents = studentId !== null
    ? studentOutput.filter((item) => Number(item.student_id) === studentId) : studentOutput;
  return {
    exams: examOutput, subjects, students: filteredStudents,
    records: records.filter((row) =>
      studentId === null || Number(row.student_id) === studentId),
    definition: {
      missing: '缺考、免考和未录入均不按 0 分计入平均分。',
      total: '只有考试配置中的预期科目全部为正常数值成绩时才计算总分。',
      rank: '班级排名仅在总分完整的学生中按总分降序计算，同分同名次。',
      stratum: 'A/B/C 层按完整总分排名的前 25%/中间 50%/后 25% 划分。',
    },
  };
}

export function listUpcomingExams(options?: { limit?: number; conn?: Database }): Array<Record<string, unknown>> {
  const conn = options?.conn ?? getDb().connInstance;
  const [classId, termId] = scopeIds({ conn });
  const businessDate = todayString();
  const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);
  const rows = conn.prepare(
    `SELECT e.id, e.name, e.exam_date, GROUP_CONCAT(DISTINCT es.name) AS subjects
     FROM score_exams e
     LEFT JOIN score_exam_subjects ses ON ses.exam_id = e.id
     LEFT JOIN score_subjects es ON es.id = ses.subject_id
     WHERE e.class_id=? AND e.term_id=? AND e.enabled=1
       AND (e.exam_date='' OR e.exam_date>=?)
     GROUP BY e.id
     ORDER BY CASE WHEN e.exam_date='' THEN 1 ELSE 0 END, e.exam_date ASC, e.sort_order ASC
     LIMIT ?`,
  ).all(classId, termId, businessDate, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const examDate = String(row.exam_date ?? '');
    let daysUntil: number | null = null;
    let label = '';
    if (examDate && /^\d{4}-\d{2}-\d{2}$/.test(examDate)) {
      const exam = new Date(`${examDate}T00:00:00Z`);
      const today = new Date(`${businessDate}T00:00:00Z`);
      daysUntil = Math.round((exam.getTime() - today.getTime()) / 86400000);
      if (daysUntil === 0) label = '今天';
      else if (daysUntil > 0) label = `${daysUntil}天后`;
      else label = '已结束';
    } else {
      label = '待补日期';
    }
    return { ...row, days_until: daysUntil, countdown_label: label };
  });
}

import * as rulesModule from './scoresRules.js';
