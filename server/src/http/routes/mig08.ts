/* MIG-08 路由：积分、班费、评语、教育记录、知识库。
 * AI 草稿端点（AGENT-00 接入）先返回提示。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';

import { getDb, ScopeError, ArchivedScopeError } from '../../services/context.js';
import * as points from '../../services/points.js';
import * as funds from '../../services/funds.js';
import * as comments from '../../services/comments.js';
import * as education from '../../services/education.js';
import * as knowledge from '../../services/knowledge.js';
import { getCurrentScope } from '../../services/context.js';

type ErrorClass = new (...args: never[]) => Error;

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(400).send({ detail: error.message });
  const known: Array<ErrorClass> = [
    points.PointError, funds.FundError, comments.CommentError,
    education.EducationError, knowledge.KnowledgeError,
  ];
  for (const ErrorType of known) {
    if (error instanceof ErrorType) {
      const message = (error as Error).message;
      if (error instanceof knowledge.KnowledgeError) {
        return reply.status(400).send({ detail: message });
      }
      const status = message.includes('不存在') || message.includes('不在当前') ? 404 : 400;
      return reply.status(status).send({ detail: message });
    }
  }
  return undefined;
}

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    const mapped = mapError(reply, error);
    if (mapped) return mapped;
    throw error;
  }
}

export function registerMig08Routes(app: FastifyInstance): void {
  // ---------- 行为积分 ----------
  app.get('/api/points', async (request) => {
    const query = request.query as Record<string, string>;
    const summary = points.classSummary({ academicYear: query.academic_year ?? '' }) as
      Record<string, unknown>;
    const entries = points.listEntries({
      studentId: query.student_id ? Number(query.student_id) : null,
      dateFrom: query.date_from ?? '', dateTo: query.date_to ?? '',
      status: query.status ?? '', academicYear: query.academic_year ?? '',
      includeLegacy: query.include_legacy !== 'false', limit: Number(query.limit ?? 500),
    });
    return { summary, entries };
  });

  app.post('/api/points/entries', async (request, reply) => wrap(reply, () => ({
    ok: true,
    entry: points.createEntry({
      studentId: Number((request.body as Record<string, unknown>).student_id),
      amount: Number((request.body as Record<string, unknown>).amount),
      occurredAt: String((request.body as Record<string, unknown>).occurred_at ?? ''),
      category: String((request.body as Record<string, unknown>).category ?? '日常行为'),
      reason: String((request.body as Record<string, unknown>).reason ?? ''),
      ruleId: (request.body as Record<string, unknown>).rule_id !== undefined
        && (request.body as Record<string, unknown>).rule_id !== null
        ? Number((request.body as Record<string, unknown>).rule_id) : null,
    }),
  })));

  app.post('/api/points/entries/:entryId/revoke', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const body = request.body as { reason?: string };
    return wrap(reply, () => ({
      ok: true,
      entry: points.revokeEntry(Number(entryId), String(body.reason ?? '')),
    }));
  });

  app.get('/api/points/rules', async (request) => {
    const { include_disabled } = request.query as { include_disabled?: string };
    return { rules: points.listRules({ includeDisabled: include_disabled === 'true' }) };
  });

  app.post('/api/points/rules', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      rule: points.createRule({
        name: String(body.name ?? ''), category: String(body.category ?? '日常行为'),
        metric: String(body.metric ?? '周期扣分'), threshold: Number(body.threshold ?? 5),
        periodDays: Number(body.period_days ?? 7), priority: String(body.priority ?? '重要'),
        enabled: body.enabled === undefined || body.enabled === null ? true : Boolean(body.enabled),
      }),
    }));
  });

  app.put('/api/points/rules/:ruleId', async (request, reply) => {
    const { ruleId } = request.params as { ruleId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      rule: points.updateRule(Number(ruleId), {
        enabled: body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled),
        threshold: body.threshold,
        periodDays: body.period_days as number | null | undefined,
        priority: body.priority as string | null | undefined,
        category: body.category as string | null | undefined,
      }),
    }));
  });

  app.post('/api/points/rules/evaluate', async (request, reply) => {
    const body = (request.body ?? {}) as { reference_date?: string };
    return wrap(reply, () => points.evaluateRules({ referenceDate: body.reference_date ?? '' }));
  });

  app.get('/api/points/rule-hits', async (request) => {
    const { status = '', limit = '200' } = request.query as { status?: string; limit?: string };
    return { hits: points.listRuleHits({ status, limit: Number(limit) }) };
  });

  // ---------- 班费 ----------
  app.get('/api/fund', async (request) => {
    const query = request.query as Record<string, string>;
    const summary = funds.classSummary({}) as Record<string, unknown>;
    const entries = funds.listEntries({
      dateFrom: query.date_from ?? '', dateTo: query.date_to ?? '',
      direction: query.direction ?? '', category: query.category ?? '',
      status: query.status ?? '', limit: Number(query.limit ?? 500),
    });
    return { summary, entries };
  });

  app.get('/api/fund/categories', async (request) => {
    const { include_disabled } = request.query as { include_disabled?: string };
    return { categories: funds.listCategories({ includeDisabled: include_disabled === 'true' }) };
  });

  app.post('/api/fund/categories', async (request, reply) => {
    const body = request.body as { name?: string; direction?: string };
    return wrap(reply, () => ({
      ok: true,
      category: funds.createCategory({
        name: String(body.name ?? ''), direction: String(body.direction ?? '支出'),
      }),
    }));
  });

  app.put('/api/fund/categories/:categoryId', async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      category: funds.updateCategory(Number(categoryId), {
        name: body.name as string | null | undefined,
        enabled: body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled),
      }),
    }));
  });

  app.post('/api/fund/entries', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      entry: funds.createEntry({
        occurredAt: String(body.occurred_at ?? ''),
        direction: String(body.direction ?? '支出'),
        amount: Number(body.amount ?? 0),
        categoryId: body.category_id !== undefined && body.category_id !== null
          ? Number(body.category_id) : null,
        category: String(body.category ?? ''),
        description: String(body.description ?? ''),
        handler: String(body.handler ?? ''), witness: String(body.witness ?? ''),
        note: String(body.note ?? ''),
      }),
    }));
  });

  app.put('/api/fund/entries/:entryId', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      entry: funds.updateEntry(Number(entryId), {
        occurredAt: body.occurred_at as string | undefined,
        direction: body.direction as string | undefined,
        amount: typeof body.amount === 'number' ? body.amount : undefined,
        categoryId: body.category_id !== undefined && body.category_id !== null
          ? Number(body.category_id) : undefined,
        category: body.category as string | undefined,
        description: body.description as string | undefined,
        handler: body.handler as string | undefined,
        witness: body.witness as string | undefined,
        note: body.note as string | undefined,
      }),
    }));
  });

  app.post('/api/fund/entries/:entryId/revoke', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const body = request.body as { reason?: string };
    return wrap(reply, () => ({
      ok: true,
      entry: funds.revokeEntry(Number(entryId), String(body.reason ?? '')),
    }));
  });

  app.post('/api/fund/entries/:entryId/reverse', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const body = request.body as { reason?: string; occurred_at?: string };
    return wrap(reply, () => ({
      ok: true,
      entry: funds.reverseEntry(Number(entryId), String(body.reason ?? ''),
        { occurredAt: String(body.occurred_at ?? '') }),
    }));
  });

  app.get('/api/fund/settlements', async () => ({ settlements: funds.listSettlements() }));

  app.post('/api/fund/settlements', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      settlement: funds.createSettlement({
        periodStart: String(body.period_start ?? ''), periodEnd: String(body.period_end ?? ''),
        countedBalance: body.counted_balance !== undefined && body.counted_balance !== null
          ? Number(body.counted_balance) : null,
        note: String(body.note ?? ''),
      }),
    }));
  });

  app.post('/api/fund/settlements/:settlementId/reconcile', async (request, reply) => {
    const { settlementId } = request.params as { settlementId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      settlement: funds.reconcileSettlement(Number(settlementId), {
        countedBalance: body.counted_balance !== undefined && body.counted_balance !== null
          ? Number(body.counted_balance) : null,
        note: body.note as string | undefined,
      }),
    }));
  });

  app.post('/api/fund/entries/:entryId/attachments', async (request, reply) => {
    const { entryId } = request.params as { entryId: string };
    const data = await readUpload(request);
    return wrap(reply, () => ({
      ok: true,
      attachment: funds.saveAttachment(Number(entryId), {
        filename: data.filename || '班费凭证',
        contentType: data.contentType || 'application/octet-stream',
        content: data.buffer,
      }),
    }));
  });

  app.get('/api/fund/attachments/:attachmentId', async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };
    try {
      const result = funds.attachmentFile(Number(attachmentId));
      reply.header('Content-Type', String(result.attachment.content_type));
      reply.header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(String(result.attachment.original_name))}`);
      return reply.send(fs.createReadStream(result.path));
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------- 评语 ----------
  app.get('/api/comments', async (request) => {
    const query = request.query as Record<string, string>;
    const summary = comments.summary() as Record<string, unknown>;
    const rows = comments.listComments({
      studentId: query.student_id ? Number(query.student_id) : null,
      commentType: query.comment_type ?? '', status: query.status ?? '',
      keyword: query.keyword ?? '', limit: Number(query.limit ?? 500),
    });
    return { summary, comments: rows };
  });

  app.get('/api/comments/templates', async (request) => {
    const { include_disabled } = request.query as { include_disabled?: string };
    return { templates: comments.listTemplates({ includeDisabled: include_disabled === 'true' }) };
  });

  app.post('/api/comments/templates', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      template: comments.createTemplate({
        name: String(body.name ?? ''), commentType: String(body.comment_type ?? '学期评语'),
        content: String(body.content ?? ''), enabled: body.enabled !== false,
      }),
    }));
  });

  app.put('/api/comments/templates/:templateId', async (request, reply) => {
    const { templateId } = request.params as { templateId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      template: comments.updateTemplate(Number(templateId), {
        name: body.name as string | null | undefined,
        commentType: body.comment_type as string | null | undefined,
        content: body.content as string | null | undefined,
        enabled: body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled),
      }),
    }));
  });

  app.post('/api/comments/generate/preview', async (request, reply) => {
    const body = request.body as { template_id?: number; student_ids?: number[]; comment_type?: string };
    return wrap(reply, () => comments.previewGeneration({
      templateId: Number(body.template_id ?? 0),
      studentIds: body.student_ids ?? [],
      commentType: String(body.comment_type ?? ''),
    }));
  });

  app.post('/api/comments/generate', async (request, reply) => {
    const body = request.body as {
      template_id?: number; student_ids?: number[]; comment_type?: string; confirm_missing?: boolean;
    };
    return wrap(reply, () => ({
      ok: true,
      ...comments.generateBatch({
        templateId: Number(body.template_id ?? 0),
        studentIds: body.student_ids ?? [],
        commentType: String(body.comment_type ?? ''),
        confirmMissing: body.confirm_missing === true,
      }),
    }));
  });

  app.post('/api/comments/ai/preview', async (request, reply) => {
    const body = request.body as {
      student_ids?: number[]; comment_type?: string; tone?: string; length?: string; instruction?: string;
    };
    try {
      const commentDrafter = await import('../../agent/commentDrafter.js');
      return await commentDrafter.previewGeneration({
        studentIds: body.student_ids ?? [],
        commentType: String(body.comment_type ?? '学期评语'),
        tone: String(body.tone ?? '温和、客观、鼓励'),
        length: String(body.length ?? '120-160字'),
        instruction: String(body.instruction ?? ''),
      });
    } catch (error) {
      if (error instanceof Error && (error.constructor.name === 'CommentAIDraftError'
        || error.constructor.name === 'ModelError' || error.constructor.name === 'ModelNotConfigured')) {
        return reply.status(400).send({ detail: error.message });
      }
      throw error;
    }
  });

  app.post('/api/comments/ai/generate', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => ({
      ok: true,
      ...comments.saveAiDrafts({
        rows: Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [],
        commentType: String(body.comment_type ?? '学期评语'),
        model: String(body.model ?? ''),
        period: (body.period ?? {}) as Record<string, unknown>,
      }),
    }));
  });

  app.post('/api/comments/entries', async (request, reply) => {
    const body = request.body as { student_id?: number; comment_type?: string; content?: string; note?: string };
    return wrap(reply, () => ({
      ok: true,
      comment: comments.createComment({
        studentId: Number(body.student_id ?? 0),
        commentType: String(body.comment_type ?? '学期评语'),
        content: String(body.content ?? ''), note: String(body.note ?? ''),
      }),
    }));
  });

  app.put('/api/comments/entries/:commentId', async (request, reply) => {
    const { commentId } = request.params as { commentId: string };
    const body = request.body as { content?: string; note?: string };
    return wrap(reply, () => ({
      ok: true,
      comment: comments.updateComment(Number(commentId), {
        content: body.content as string | null | undefined,
        note: body.note as string | null | undefined,
      }),
    }));
  });

  app.post('/api/comments/entries/:commentId/transition', async (request, reply) => {
    const { commentId } = request.params as { commentId: string };
    const body = request.body as { target_status?: string; note?: string; delivery_method?: string };
    return wrap(reply, () => ({
      ok: true,
      comment: comments.transitionComment(Number(commentId), String(body.target_status ?? ''), {
        note: String(body.note ?? ''), deliveryMethod: String(body.delivery_method ?? ''),
      }),
    }));
  });

  app.get('/api/comments/entries/:commentId/versions', async (request, reply) => {
    const { commentId } = request.params as { commentId: string };
    return wrap(reply, () => ({ versions: comments.commentVersions(Number(commentId)) }));
  });

  app.get('/api/comments/print', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const rows = comments.listComments({
      studentId: query.student_id ? Number(query.student_id) : null,
      commentType: query.comment_type ?? '', status: query.status ?? '', limit: 5000,
    });
    const scope = getCurrentScope();
    const title = `${scope.class_name} · ${scope.term_name} · 学生评语`;
    const cards = rows.map((item) => {
      const studentName = String(item.student_name ?? '');
      const no = String(item.学号 ?? '');
      const content = String(item.content ?? '').replace(/\n/g, '<br>');
      return `<article><h2>${escapeHtml(studentName)}<small>${escapeHtml(no)}</small></h2>`
        + `<p>${escapeHtml(content)}</p>`
        + `<footer>${escapeHtml(String(item.comment_type ?? ''))} · ${escapeHtml(String(item.status ?? ''))}</footer></article>`;
    }).join('') || '<p class="empty">没有符合条件的评语。</p>';
    const document = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>${escapeHtml(title)}</title><link rel="icon" href="/favicon.svg"><style>
    @page{size:A4 portrait;margin:14mm}
    body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1d1d1f;margin:0}
    header{display:flex;justify-content:space-between;border-bottom:2px solid #5968bd;padding-bottom:12px;margin-bottom:20px}
    header h1{font-size:22px;margin:0}header button{padding:8px 14px}
    article{break-inside:avoid;border:1px solid #ddd;border-radius:10px;padding:18px;margin:0 0 14px}
    h2{font-size:17px;margin:0 0 12px}h2 small{font-size:12px;color:#777;margin-left:10px;font-weight:400}
    p{font-size:14px;line-height:1.8;margin:0}footer{font-size:11px;color:#777;margin-top:12px}
    .empty{text-align:center;color:#777}@media print{header button{display:none}article{border-color:#aaa;break-inside:avoid}}
    </style></head><body><header><h1>${escapeHtml(title)}</h1><button onclick="window.print()">打印</button></header>${cards}</body></html>`;
    return reply.type('text/html; charset=utf-8').send(document);
  });

  // ---------- 教育记录 ----------
  app.get('/api/education/meetings', async (request) => {
    const query = request.query as Record<string, string>;
    return { meetings: education.listMeetings({
      query: query.query ?? '', dateFrom: query.date_from ?? '', dateTo: query.date_to ?? '',
    }) };
  });

  app.get('/api/education/meetings/:meetingId', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    return wrap(reply, () => {
      const meetings = education.listMeetings({});
      const item = meetings.find((entry) => entry.id === Number(meetingId));
      if (!item) return reply.status(404).send({ detail: '班会记录不存在' });
      return item;
    });
  });

  app.post('/api/education/meetings', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => education.createMeeting({
      heldOn: String(body.held_on ?? ''), topic: String(body.topic ?? ''),
      format: String(body.format ?? '主题班会'), content: String(body.content ?? ''),
      participation: String(body.participation ?? ''), conclusion: String(body.conclusion ?? ''),
      status: String(body.status ?? '已记录'),
      templateId: body.template_id !== undefined && body.template_id !== null
        ? Number(body.template_id) : null,
      studentIds: body.student_ids,
      actionItems: Array.isArray(body.action_items) ? (body.action_items as Array<Record<string, unknown>>) : null,
      followupTitle: String(body.followup_title ?? ''), followupDue: String(body.followup_due ?? ''),
    }));
  });

  app.put('/api/education/meetings/:meetingId', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => education.updateMeeting(Number(meetingId), { values: body }));
  });

  app.delete('/api/education/meetings/:meetingId', async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    return wrap(reply, () => education.deleteRecord('meeting', Number(meetingId)));
  });

  app.get('/api/education/activities', async (request) => {
    const query = request.query as Record<string, string>;
    return { activities: education.listActivities({
      query: query.query ?? '', dateFrom: query.date_from ?? '', dateTo: query.date_to ?? '',
    }) };
  });

  app.get('/api/education/activities/:activityId', async (request, reply) => {
    const { activityId } = request.params as { activityId: string };
    return wrap(reply, () => {
      const activities = education.listActivities({});
      const item = activities.find((entry) => entry.id === Number(activityId));
      if (!item) return reply.status(404).send({ detail: '活动记录不存在' });
      return item;
    });
  });

  app.post('/api/education/activities', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => education.createActivity({
      occurredOn: String(body.occurred_on ?? ''), name: String(body.name ?? ''),
      activityType: String(body.activity_type ?? '其他'),
      budget: body.budget, participantCount: body.participant_count,
      summary: String(body.summary ?? ''), result: String(body.result ?? ''),
      retrospective: String(body.retrospective ?? ''), status: String(body.status ?? '计划中'),
      templateId: body.template_id !== undefined && body.template_id !== null
        ? Number(body.template_id) : null,
      studentIds: body.student_ids,
      followupTitle: String(body.followup_title ?? ''), followupDue: String(body.followup_due ?? ''),
    }));
  });

  app.put('/api/education/activities/:activityId', async (request, reply) => {
    const { activityId } = request.params as { activityId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => education.updateActivity(Number(activityId), { values: body }));
  });

  app.delete('/api/education/activities/:activityId', async (request, reply) => {
    const { activityId } = request.params as { activityId: string };
    return wrap(reply, () => education.deleteRecord('activity', Number(activityId)));
  });

  app.post('/api/education/activities/:activityId/attachments', async (request, reply) => {
    const { activityId } = request.params as { activityId: string };
    const data = await readUpload(request);
    return wrap(reply, () => ({
      ok: true,
      attachment: education.saveActivityAttachment(Number(activityId), {
        filename: data.filename || '附件',
        mimeType: data.contentType || 'application/octet-stream',
        content: data.buffer,
      }),
    }));
  });

  app.get('/api/education/activities/attachments/:attachmentId', async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };
    try {
      const result = education.activityAttachmentFile(Number(attachmentId));
      reply.header('Content-Type', String(result.attachment.mime_type || 'application/octet-stream'));
      reply.header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(String(result.attachment.original_name))}`);
      return reply.send(fs.createReadStream(result.path));
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get('/api/education/diary', async (request) => {
    const query = request.query as Record<string, string>;
    return { entries: education.listDiary({
      month: query.query ?? '', dateFrom: query.date_from ?? '', dateTo: query.date_to ?? '',
    }) };
  });

  app.post('/api/education/diary', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => education.createDiary({
      diaryDate: String(body.diary_date ?? ''), weather: String(body.weather ?? ''),
      work: String(body.work ?? ''), event: String(body.event ?? ''),
      reflection: String(body.reflection ?? ''), todo: String(body.todo ?? ''),
      links: Array.isArray(body.links) ? (body.links as Array<Record<string, unknown>>) : undefined,
    }));
  });

  app.put('/api/education/diary/:diaryId', async (request, reply) => {
    const { diaryId } = request.params as { diaryId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => education.updateDiary(Number(diaryId), { values: body }));
  });

  app.delete('/api/education/diary/:diaryId', async (request, reply) => {
    const { diaryId } = request.params as { diaryId: string };
    return wrap(reply, () => education.deleteRecord('diary', Number(diaryId)));
  });

  app.get('/api/education/templates', async () => ({ templates: education.listTemplates({}) }));

  app.post('/api/education/templates', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => education.createTemplate(String(body.kind ?? 'meeting'), {
      name: String(body.name ?? ''), content: String(body.content ?? ''),
      format: String(body.format ?? '主题班会'), activityType: String(body.activity_type ?? '其他'),
      description: String(body.description ?? ''),
    }));
  });

  app.post('/api/education/migrate', async (_request, reply) =>
    wrap(reply, () => education.migrateLegacyRows()));

  // ---------- 知识库 ----------
  app.get('/api/knowledge/notes', async (request) => {
    const query = request.query as Record<string, string>;
    return knowledge.listNotes({
      query: query.q ?? '', tag: query.tag ?? '', category: query.category ?? '',
    });
  });

  app.get('/api/knowledge/notes/read', async (request, reply) => {
    const { path: relativePath } = request.query as { path?: string };
    return wrap(reply, () => knowledge.readNote(relativePath ?? ''));
  });

  app.post('/api/knowledge/create', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => knowledge.createNote({
      title: String(body.title ?? ''), category: String(body.category ?? '个人成长'),
      template: String(body.template ?? ''), content: String(body.content ?? ''),
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      links: Array.isArray(body.links) ? (body.links as Array<Record<string, unknown>>) : [],
    }));
  });

  app.put('/api/knowledge/notes/:noteId', async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const body = request.body as Record<string, unknown>;
    return wrap(reply, () => knowledge.updateNote(Number(noteId), {
      content: String(body.content ?? ''),
      expectedHash: String(body.expected_hash ?? ''),
      force: body.force === true,
      title: body.title as string | undefined,
      category: body.category as string | undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      links: Array.isArray(body.links) ? (body.links as Array<Record<string, unknown>>) : undefined,
    }));
  });

  app.post('/api/knowledge/notes/:noteId/adopt', async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    return wrap(reply, () => knowledge.adoptExternalChange(Number(noteId)));
  });

  app.get('/api/knowledge/sync', async (_request, reply) =>
    wrap(reply, () => {
      knowledge.evaluateStartup();
      return { ok: true };
    }));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readUpload(request: { file?: () => Promise<{
  toBuffer: () => Promise<Buffer>; filename?: string; mimetype?: string;
} | undefined> }): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  if (typeof request.file === 'function') {
    const part = await request.file();
    if (!part) return { buffer: Buffer.alloc(0), filename: '', contentType: '' };
    return {
      buffer: await part.toBuffer(),
      filename: part.filename ?? '',
      contentType: part.mimetype ?? '',
    };
  }
  return { buffer: Buffer.alloc(0), filename: '', contentType: '' };
}

export { getDb };
