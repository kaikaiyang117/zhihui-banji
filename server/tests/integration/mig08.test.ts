/* MIG-08 账目与教育沉淀测试：积分、班费、评语、教育记录、知识库。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import * as points from '../../src/services/points.js';
import * as funds from '../../src/services/funds.js';
import * as comments from '../../src/services/comments.js';
import * as education from '../../src/services/education.js';
import * as knowledge from '../../src/services/knowledge.js';
import { updateWorkItem } from '../../src/services/workItems.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let db: WorkbenchDb;

function testConfig(): ReturnType<typeof loadConfig> {
  const previous = { ...process.env };
  process.env.WORKBENCH_DATA_DIR = tempDir;
  process.env.WORKBENCH_STATIC_DIR = path.join(SERVER_ROOT, 'tests', 'fixtures', 'static');
  process.env.WORKBENCH_VERSION = '9.8.7';
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  const config = loadConfig();
  process.env = previous;
  return config;
}

function seed(): void {
  const conn = db.connInstance;
  for (let index = 1; index <= 3; index += 1) {
    conn.prepare('INSERT INTO students(学号, 姓名, 性别) VALUES(?,?,?)')
      .run(`S${String(index).padStart(3, '0')}`, `账目学生${index}`, index % 2 ? '男' : '女');
  }
  conn.prepare(
    `INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status)
     SELECT id, 1, 1, '在读' FROM students`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig08-'));
  process.env.WORKBENCH_BUSINESS_DATE = '2026-04-15';
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  seed();
});

afterEach(() => {
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('行为积分', () => {
  it('流水/撤销/统计', () => {
    points.createEntry({ studentId: 1, amount: 5, reason: '课堂表现' });
    points.createEntry({ studentId: 1, amount: -3, reason: '迟到扣分' });
    const summary = points.classSummary({}) as Record<string, unknown>;
    const totals = summary.totals as Record<string, unknown>;
    expect(totals.total).toBe(2);
    const entries = points.listEntries({ studentId: 1 });
    expect(entries).toHaveLength(2);
    const plus = entries.find((item) => Number(item.amount) === 5) as Record<string, unknown>;
    const revoked = points.revokeEntry(Number(plus.id), '撤销原因');
    expect(revoked.status).toBe('已撤销');
    const after = points.classSummary({}) as Record<string, unknown>;
    expect((after.totals as Record<string, unknown>).total).toBe(-3);
  });

  it('规则命中 → 工作项 → 完成已处理', () => {
    points.createRule({ name: '扣分规则', metric: '周期扣分', threshold: 5, periodDays: 7 });
    points.createEntry({ studentId: 1, amount: -6, reason: '三次扣分' });
    const evaluation = points.evaluateRules({ referenceDate: '2026-04-15' }) as Record<string, unknown>;
    expect(evaluation.created_count).toBe(1);
    const task = db.connInstance.prepare(
      "SELECT id FROM student_tasks WHERE source_type='point_rule'",
    ).get() as { id: number };
    updateWorkItem(Number(task.id), { status: '已完成', result: '已教育' });
    const hit = db.connInstance.prepare(
      "SELECT status FROM point_rule_hits WHERE task_id=?",
    ).get(task.id) as { status: string };
    expect(hit.status).toBe('已处理');
  });

  it('旧工作表数据迁移', () => {
    const conn = db.connInstance;
    conn.prepare(
      "INSERT INTO sheet_rows(sheet, row_no, data, class_id, term_id) VALUES('日常行为积分', 1, ?, 1, 1)",
    ).run(JSON.stringify(['S001', null, 5, 3, null, null, null, null, null, null, null, null, null, null, null]));
    points.migrateLegacyRows({ conn });
    const entries = points.listEntries({ includeLegacy: true });
    expect(entries.length).toBe(2);
    const amounts = entries.map((item) => Number(item.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([3, 5]);
    // 重复执行幂等
    points.migrateLegacyRows({ conn });
    expect(points.listEntries({ includeLegacy: true }).length).toBe(2);
  });
});

describe('班费', () => {
  it('流水/结算/撤销/冲正业务规则', () => {
    const entry = funds.createEntry({ direction: '支出', amount: 50, description: '班费支出' });
    const entryId = Number(entry.id);
    // 未结算可直接撤销
    const revoke = funds.revokeEntry(entryId, '记录有误');
    expect(revoke.status).toBe('已撤销');
    // 撤销后不能再操作
    expect(() => funds.reverseEntry(entryId, '冲正')).toThrow(/有效流水|撤销|冲正/);
  });

  it('凭证通过 HTTP 返回文件内容并校验完整性', async () => {
    const entry = funds.createEntry({ direction: '支出', amount: 50, description: '带凭证支出' });
    const content = Buffer.from('fund receipt');
    const saved = funds.saveAttachment(Number(entry.id), {
      filename: '凭证.txt', contentType: 'text/plain', content,
    });
    expect(saved.download_path).toBe(`/api/fund/attachments/${saved.id}?class_id=1&term_id=1`);

    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: String(saved.download_path) });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(content.toString());
    expect(response.headers['content-disposition']).toContain('filename*=UTF-8');
    await app.close();

    const attachment = funds.attachmentFile(Number(saved.id));
    fs.writeFileSync(attachment.path, Buffer.from('tampered'));
    expect(() => funds.attachmentFile(Number(saved.id))).toThrow(/完整性/);
  });

  it('结算后只能冲正', () => {
    funds.createEntry({ direction: '收入', amount: 200, description: '班费收入', occurredAt: '2026-03-10' });
    funds.createSettlement({ periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    const entries = funds.listEntries({});
    const entry = entries[0] as Record<string, unknown>;
    const reverse = funds.reverseEntry(Number(entry.id), '重复入账') as Record<string, unknown>;
    // 返回的是新冲正流水（有效），原流水标记已冲正
    expect(Number(reverse.reversal_of_id)).toBe(Number(entry.id));
    const original = (funds.listEntries({}) as Array<Record<string, unknown>>)
      .find((item) => Number(item.id) === Number(entry.id));
    expect(original?.status).toBe('已冲正');
  });

  it('结算对账', () => {
    funds.createEntry({ direction: '收入', amount: 100, description: '收班费', occurredAt: '2026-03-05' });
    const created = funds.createSettlement({ periodStart: '2026-03-01', periodEnd: '2026-03-31' }) as
      Record<string, unknown>;
    const settlementId = Number(created.id);
    const reconciled = funds.reconcileSettlement(settlementId, { countedBalance: 100 }) as
      Record<string, unknown>;
    expect(reconciled.difference).toBe(0);
  });
});

describe('评语', () => {
  it('状态机流转与版本历史', () => {
    const created = comments.createComment({
      studentId: 1, commentType: '学期评语', content: '表现良好',
    }) as Record<string, unknown>;
    const commentId = Number(created.id);
    // 草稿 → 待审核 → 完成
    comments.transitionComment(commentId, '待审核', { note: '提交审核' });
    comments.transitionComment(commentId, '完成', { note: '审核通过' });
    // 不能从完成直接回草稿
    expect(() => comments.transitionComment(commentId, '草稿', { note: '' }))
      .toThrow(/状态流转|不能/);
    const versions = comments.commentVersions(commentId);
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it('模板生成：缺失变量标记与人工保护', () => {
    comments.createTemplate({ name: '学期模板', commentType: '学期评语', content: '{{姓名}}同学，{{备注}}' });
    const preview = comments.previewGeneration({
      templateId: 1, studentIds: [1], commentType: '学期评语',
    }) as Record<string, unknown>;
    expect((preview.rows as Array<Record<string, unknown>>)[0].missing_variables)
      .toContain('备注');
  });
});

describe('教育记录', () => {
  it('班会行动项生成统一工作项', () => {
    const meeting = education.createMeeting({
      heldOn: '2026-04-15', topic: '纪律班会', content: '课堂纪律',
      actionItems: [{ title: '跟进小明', due_at: '2026-04-20' }],
    }) as Record<string, unknown>;
    expect(Number(meeting.id)).toBeGreaterThan(0);
    const task = db.connInstance.prepare(
      "SELECT * FROM student_tasks WHERE source_type='meeting_action'",
    ).get();
    expect(task).toBeTruthy();
  });

  it('活动附件通过 HTTP 返回文件内容并校验完整性', async () => {
    const activity = education.createActivity({
      occurredOn: '2026-04-15', name: '春游', summary: '安全出行',
    }) as Record<string, unknown>;
    const content = Buffer.from('%PDF 内容');
    const saved = education.saveActivityAttachment(Number(activity.id), {
      filename: '方案.pdf', mimeType: 'application/pdf', content,
    });
    expect(saved.original_name).toBe('方案.pdf');
    const result = education.activityAttachmentFile(Number(saved.id));
    expect(fs.existsSync(result.path)).toBe(true);
    expect(saved.download_path).toBe(`/api/education/activities/attachments/${saved.id}?class_id=1&term_id=1`);

    const app = buildApp({ config: testConfig() });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: String(saved.download_path) });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(content.toString());
    expect(response.headers['content-disposition']).toContain('filename*=UTF-8');
    await app.close();

    fs.writeFileSync(result.path, Buffer.from('tampered'));
    expect(() => education.activityAttachmentFile(Number(saved.id))).toThrow(/完整性/);
  });

  it('日志与关联', () => {
    const diary = education.createDiary({
      diaryDate: '2026-04-15', work: '批改作业', links: [{ link_type: 'student', link_id: 1, label: '甲' }],
    }) as Record<string, unknown>;
    expect(Number(diary.id)).toBeGreaterThan(0);
    const entries = education.listDiary({ month: '2026-04' });
    expect(entries).toHaveLength(1);
  });
});

describe('知识库', () => {
  it('创建/读取/更新/外部冲突', () => {
    const note = knowledge.createNote({
      title: '牛顿定律', category: '物理', content: 'F=ma', tags: ['力学'],
    }) as Record<string, unknown>;
    expect(note.id).toBeGreaterThan(0);
    const read = knowledge.readNote(String(note.relative_path));
    expect(String(read.content)).toContain('F=ma');

    // 外部修改 → 冲突
    const filePath = path.join(db.paths.kbDir, String(note.relative_path));
    fs.writeFileSync(filePath, '# 外部修改\nF=ma（外部）');
    expect(() => knowledge.updateNote(Number(note.id), {
      content: '内部修改', expectedHash: String(note.content_hash),
    })).toThrow(/外部/);

    // force 覆盖
    const forced = knowledge.updateNote(Number(note.id), {
      content: '内部覆盖', expectedHash: String(note.content_hash), force: true,
    }) as Record<string, unknown>;
    expect(forced.sync_status).toBe('同步');
    const list = knowledge.listNotes({ query: '内部' });
    expect((list.notes as Array<Record<string, unknown>>).length).toBe(1);
  });

  it('重名笔记被拒', () => {
    knowledge.createNote({ title: '同一标题', content: 'x' });
    expect(() => knowledge.createNote({ title: '同一标题', content: 'y' }))
      .toThrow(/已存在/);
  });
});

describe('HTTP 冒烟', () => {
  it('积分/班费/评语/教育/知识库端点连通', async () => {
    const app = buildApp({ config: testConfig() });
    await app.ready();

    const point = await app.inject({
      method: 'POST', url: '/api/points/entries',
      payload: { student_id: 1, amount: 5, reason: '表现' },
    });
    expect(point.statusCode).toBe(200);

    const fund = await app.inject({
      method: 'POST', url: '/api/fund/entries',
      payload: { direction: '支出', amount: 10, description: '买笔' },
    });
    expect(fund.statusCode).toBe(200);

    const comment = await app.inject({
      method: 'POST', url: '/api/comments/entries',
      payload: { student_id: 1, content: '评语内容' },
    });
    expect(comment.statusCode).toBe(200);

    const meeting = await app.inject({
      method: 'POST', url: '/api/education/meetings',
      payload: { topic: '班会', held_on: '2026-04-15' },
    });
    expect(meeting.statusCode).toBe(200);

    const note = await app.inject({
      method: 'POST', url: '/api/knowledge/create',
      payload: { title: 'HTTP笔记', content: '内容' },
    });
    expect(note.statusCode).toBe(200);

    const aiStub = await app.inject({
      method: 'POST', url: '/api/comments/ai/preview',
      payload: { student_ids: [1] },
    });
    expect(aiStub.statusCode).toBe(400); // 未配置模型 → 明确错误提示
    expect(aiStub.json().detail).toContain('模型');

    const pointsList = await app.inject({ method: 'GET', url: '/api/points' });
    expect(pointsList.statusCode).toBe(200);
    const fundList = await app.inject({ method: 'GET', url: '/api/fund' });
    expect(fundList.statusCode).toBe(200);
    await app.close();
  });
});
