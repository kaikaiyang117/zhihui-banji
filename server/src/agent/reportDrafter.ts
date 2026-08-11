import { ModelError, OpenAICompatibleClient, type ModelResponse } from './modelClient.js';

export class ReportAIDraftError extends Error {}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function clip(value: unknown, limit = 240): string {
  const t = text(value);
  return t.length <= limit ? t : t.slice(0, limit - 1) + '…';
}

function parseJson(content: string): Record<string, unknown> {
  const raw = text(content).replace(/^```(?:json)?\s*|\s*```$/gi, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ReportAIDraftError('AI返回内容不是有效的结构化档案草稿');
  }
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new ReportAIDraftError('AI返回内容无法解析为档案草稿');
  }
  const required = ['class_summary', 'next_term_plan', 'teacher_summary'] as const;
  if (typeof data !== 'object' || data === null || Array.isArray(data)
    || required.some((key) => typeof (data as Record<string, unknown>)[key] !== 'string')) {
    throw new ReportAIDraftError('AI返回结果缺少完整的档案草稿字段');
  }
  return data as Record<string, unknown>;
}

function context(report: Record<string, unknown>): Record<string, unknown> {
  const analysis = (report.analysis ?? {}) as Record<string, unknown>;
  const academic = { ...((analysis.academic ?? {}) as Record<string, unknown>) };
  const improved = Array.isArray(academic.improved_students) ? academic.improved_students.length : 0;
  const declined = Array.isArray(academic.declined_students) ? academic.declined_students.length : 0;
  delete academic.improved_students;
  delete academic.declined_students;
  academic.improved_student_count = improved;
  academic.declined_student_count = declined;
  const sections = (report.sections ?? {}) as Record<string, unknown>;
  const educationMaterials = {
    meetings: ((sections.meetings ?? []) as Array<Record<string, unknown>>).slice(0, 12).map((row) => ({
      date: row.date,
      title: row.title,
      conclusion: clip(row.conclusion),
    })),
    activities: ((sections.activities ?? []) as Array<Record<string, unknown>>).slice(0, 12).map((row) => ({
      date: row.date,
      title: row.title,
      result: clip(row.result),
      retrospective: clip(row.retrospective),
    })),
    diary: ((sections.diary ?? []) as Array<Record<string, unknown>>).slice(0, 12).map((row) => ({
      date: row.date,
      work: clip(row.work),
      event: clip(row.event),
      reflection: clip(row.reflection),
    })),
  };
  return {
    scope: report.scope ?? {},
    period: { start: report.period_start, end: report.period_end },
    metrics: report.metrics ?? {},
    analysis: {
      class_overview: analysis.class_overview ?? {},
      academic,
      attendance: analysis.attendance ?? {},
      tasks: analysis.tasks ?? {},
    },
    education_materials: educationMaterials,
    data_notes: report.data_notes ?? [],
  };
}

export async function generateDraft(options: {
  report: Record<string, unknown>;
  instruction?: string;
  model_client?: OpenAICompatibleClient;
  modelClient?: OpenAICompatibleClient;
}): Promise<Record<string, unknown>> {
  const client = options.modelClient ?? options.model_client ?? new OpenAICompatibleClient();
  const system = (
    '你是高中班主任的学期总结助手。只能根据提供的结构化事实和教育记录生成草稿，绝不补充不存在的事实。'
    + '输出中文，表达具体、克制、尊重学生；不要公开点名、排名或给学生贴标签，不做心理或医学诊断。'
    + '班级整体表现要说明已知事实和需要老师判断的部分；下学期计划要可执行；班主任总结要有温度但不能空泛。'
    + '如果数据不足，明确写“待老师补充”，不要猜测。只输出严格 JSON，不要 Markdown：'
    + '{"class_summary":"...","next_term_plan":"...","teacher_summary":"...","evidence":["..."],"warnings":["..."]}'
  );
  const user: Record<string, unknown> = {
    '任务': '生成高中班主任学期档案的三段草稿',
    '老师补充要求': clip(options.instruction ?? '', 500),
    '事实与统计': context(options.report),
  };
  let response: ModelResponse;
  try {
    response = await client.complete([
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) },
    ]);
  } catch (error) {
    if (error instanceof ModelError) {
      throw new ReportAIDraftError(error.message);
    }
    throw error;
  }
  const data = parseJson(response.content);
  const draft: Record<string, unknown> = {};
  for (const key of ['class_summary', 'next_term_plan', 'teacher_summary']) {
    draft[key] = clip(data[key], 5000);
  }
  const evidence = (Array.isArray(data.evidence) ? data.evidence : [])
    .filter((item) => text(item))
    .map((item) => clip(item, 180))
    .slice(0, 8);
  const warnings = (Array.isArray(data.warnings) ? data.warnings : [])
    .filter((item) => text(item))
    .map((item) => clip(item, 180))
    .slice(0, 8);
  return { draft, evidence, warnings, model: client.config.model };
}
