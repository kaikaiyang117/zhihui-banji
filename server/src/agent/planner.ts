import type { ModelResponse, OpenAICompatibleClient } from './modelClient.js';
import type { ToolRegistry } from './toolRegistry.js';

export const MAX_PLAN_STEPS = 6;
const ALLOWED_CONDITIONS = new Set(['exactly_one_student', 'student_found']);

export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningError';
  }
}

export interface PlanStep {
  readonly id: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly depends_on: readonly string[];
  readonly condition: string;
}

export class AgentPlan {
  readonly goal: string;
  readonly steps: readonly PlanStep[];

  constructor(goal: string, steps: readonly PlanStep[]) {
    this.goal = goal;
    this.steps = steps;
  }

  static fromPayload(payloadValue: unknown, registry: ToolRegistry): AgentPlan {
    let payload: unknown = payloadValue;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const nested = (payload as Record<string, unknown>)['plan'];
      if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
        payload = nested;
      }
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new PlanningError('计划必须是对象');
    }
    const obj = payload as Record<string, unknown>;
    const goal = String(obj['goal'] || '').trim();
    const raw_steps = obj['steps'];
    if (!goal || !Array.isArray(raw_steps) || raw_steps.length === 0) {
      throw new PlanningError('计划必须包含目标和步骤');
    }
    if (raw_steps.length > MAX_PLAN_STEPS) {
      throw new PlanningError(`计划步骤不能超过 ${MAX_PLAN_STEPS} 步`);
    }
    const steps: PlanStep[] = [];
    const seen = new Set<string>();
    for (const raw of raw_steps) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new PlanningError('计划步骤格式不正确');
      }
      const step = raw as Record<string, unknown>;
      const step_id = String(step['id'] || '').trim();
      const tool_name = String(step['tool'] || '').trim();
      const argumentsValue = 'arguments' in step ? step['arguments'] : {};
      const dependencies = 'depends_on' in step ? step['depends_on'] : [];
      const condition = String(step['condition'] || '').trim();
      if (!step_id || seen.has(step_id)) {
        throw new PlanningError('计划步骤 ID 必须唯一');
      }
      const definition = registry.get(tool_name);
      if (!definition) {
        throw new PlanningError(`计划使用了不存在的工具：${tool_name}`);
      }
      if (definition.writeAction) {
        /* 计划路径不经确认直接执行，必须只读；写操作走模型预览-确认流程。 */
        throw new PlanningError(`计划步骤不能包含写入工具：${tool_name}`);
      }
      if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) {
        throw new PlanningError(`步骤 ${step_id} 的参数必须是对象`);
      }
      if (!Array.isArray(dependencies) || dependencies.some((item) => typeof item !== 'string')) {
        throw new PlanningError(`步骤 ${step_id} 的依赖格式不正确`);
      }
      if (condition && !ALLOWED_CONDITIONS.has(condition)) {
        throw new PlanningError(`步骤 ${step_id} 使用了不支持的条件`);
      }
      if (dependencies.some((item) => !seen.has(item))) {
        throw new PlanningError(`步骤 ${step_id} 依赖了尚未定义的步骤`);
      }
      steps.push({
        id: step_id,
        tool: tool_name,
        arguments: argumentsValue as Record<string, unknown>,
        depends_on: [...dependencies],
        condition,
      });
      seen.add(step_id);
    }
    return new AgentPlan(goal, steps);
  }
}

export type UsageRecorder = (
  response: ModelResponse | null,
  started: number,
  status: string,
  error: string,
) => void;

export class AgentPlanner {
  readonly model_client: OpenAICompatibleClient;
  readonly usage_recorder: UsageRecorder | null;

  constructor(model_client: OpenAICompatibleClient, usage_recorder: UsageRecorder | null = null) {
    this.model_client = model_client;
    this.usage_recorder = usage_recorder;
  }

  async create(text: string, registry: ToolRegistry, context = ''): Promise<AgentPlan> {
    const started = performance.now();
    let response: ModelResponse;
    try {
      response = await this.model_client.complete([
        { role: 'system', content: _planner_prompt(registry) },
        { role: 'user', content: _planner_input(text, context) },
      ]);
    } catch (error) {
      if (this.usage_recorder) {
        this.usage_recorder(null, started, 'error', error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    if (this.usage_recorder) {
      this.usage_recorder(response, started, 'success', '');
    }
    return AgentPlanner._from_response(response, registry);
  }

  async create_stream(text: string, registry: ToolRegistry, context = ''): Promise<AgentPlan> {
    const started = performance.now();
    let response: ModelResponse | null = null;
    try {
      for await (const event of this.model_client.iter_complete([
        { role: 'system', content: _planner_prompt(registry) },
        { role: 'user', content: _planner_input(text, context) },
      ])) {
        if (event.response) {
          response = event.response;
        }
      }
    } catch (error) {
      if (this.usage_recorder) {
        this.usage_recorder(null, started, 'error', error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    if (response === null) {
      if (this.usage_recorder) {
        this.usage_recorder(null, started, 'error', '规划器没有返回最终结果');
      }
      throw new PlanningError('规划器没有返回最终结果');
    }
    if (this.usage_recorder) {
      this.usage_recorder(response, started, 'success', '');
    }
    return AgentPlanner._from_response(response, registry);
  }

  private static _from_response(response: ModelResponse, registry: ToolRegistry): AgentPlan {
    if (response.tool_calls.length > 0) {
      return AgentPlan.fromPayload(_tool_calls_to_payload(response), registry);
    }
    return AgentPlan.fromPayload(_parse_json(response.content), registry);
  }
}

export function build_rule_plan(text: string, registry: ToolRegistry): AgentPlan | null {
  const normalized_text = normalize_query_text(text);
  if (_is_class_student_analysis(normalized_text)) {
    const boarding_status = _boarding_status_from_text(normalized_text);
    const occupation_query = ['家长职业', '监护人职业'].some((term) => normalized_text.includes(term));
    const distribution_query = ['分布', '分类', '各有多少', '统计'].some((term) => normalized_text.includes(term));
    if (occupation_query && distribution_query) {
      const argumentsValue: Record<string, unknown> = {
        group_by: 'guardian_occupation',
        include_empty: true,
        include_students: true,
        limit: 500,
      };
      if (boarding_status) {
        argumentsValue['boarding_status'] = boarding_status;
      }
      return AgentPlan.fromPayload({
        goal: text.trim(),
        steps: [{
          id: 'aggregate_students',
          tool: 'students_aggregate',
          arguments: argumentsValue,
        }],
      }, registry);
    }
    const fields: string[] = ['student_no', 'student_name'];
    const name_query = ['姓名', '名单', '名字'].some((term) => normalized_text.includes(term));
    if (!name_query && occupation_query) {
      fields.push('guardian_occupation');
    } else if (!name_query && ['家长', '监护人'].some((term) => normalized_text.includes(term))) {
      fields.push('guardian_name', 'guardian_occupation', 'guardian2_name', 'guardian2_relationship');
    } else if (!name_query) {
      fields.push('gender', 'birth_month', 'ethnicity', 'is_boarding', 'specialty', 'class_role');
    }
    const query_arguments: Record<string, unknown> = { fields, limit: 500 };
    if (boarding_status) {
      query_arguments['boarding_status'] = boarding_status;
    }
    return AgentPlan.fromPayload({
      goal: text.trim(),
      steps: [{
        id: 'query_students',
        tool: 'students_query',
        arguments: query_arguments,
      }],
    }, registry);
  }
  if (!_is_student_lookup(normalized_text)) {
    return null;
  }
  const keyword = _extract_student_keyword(normalized_text);
  if (!keyword) {
    return null;
  }

  const target_tools: string[] = [];
  if (['成绩', '分数', '考试', '排名'].some((term) => text.includes(term))) {
    target_tools.push('scores_summary');
  }
  if (['考勤', '出勤', '迟到', '请假', '缺勤'].some((term) => text.includes(term))) {
    target_tools.push('attendance_summary');
  }
  if (['待办', '任务', '跟进'].some((term) => text.includes(term))) {
    target_tools.push('tasks_list');
  }
  if (['沟通', '家长联系', '家校'].some((term) => text.includes(term))) {
    target_tools.push('communications_list');
  }
  if (target_tools.length === 0) {
    target_tools.push('student_get_profile');
  }
  const steps: Array<Record<string, unknown>> = [{
    id: 'search_student',
    tool: 'students_search',
    arguments: { keyword, limit: 20 },
  }];
  for (const [index, target_tool] of target_tools.entries()) {
    steps.push({
      id: `query_student_data_${index + 1}`,
      tool: target_tool,
      arguments: { student_id: '$search_student.students[0].id' },
      depends_on: ['search_student'],
      condition: 'exactly_one_student',
    });
  }
  return AgentPlan.fromPayload({
    goal: text.trim(),
    steps,
  }, registry);
}

function _is_student_lookup(text: string): boolean {
  return (
    (['学生', '同学', '学号'].some((term) => text.includes(term))
      || /(?<!\d)\d{2,}(?!\d)/.test(text))
    && ['查看', '查询', '了解', '详细', '档案', '信息', '成绩', '考勤', '待办', '沟通']
      .some((term) => text.includes(term))
  );
}

export function _is_class_student_analysis(text: string): boolean {
  const scope_terms = [
    '所有学生', '所有的学生', '每个学生', '每名学生', '全班学生', '全班的学生',
    '班里学生', '班里的学生', '班上学生', '班上的学生',
    '学生家长', '学生的家长', '全班家长', '全班监护人', '家长职业', '监护人职业',
    '走读学生', '住校学生', '走读的学生', '住校的学生',
  ];
  const analysis_terms = ['查看', '查询', '统计', '分析', '职业', '信息', '分布', '哪些'];
  return scope_terms.some((term) => text.includes(term))
    && analysis_terms.some((term) => text.includes(term));
}

function _boarding_status_from_text(text: string): string {
  if (text.includes('走读') || text.includes('不住校')) {
    return '走读';
  }
  if (text.includes('住校')) {
    return '住校';
  }
  return '';
}

export function normalize_query_text(text: string): string {
  let normalized = String(text ?? '').trim().replace(/\s+/g, '');
  normalized = normalized.replace(/(所有|全班|班里|班上)的学生/g, '$1学生');
  normalized = normalized.replace(/每名学生/g, '每个学生');
  normalized = normalized.replace(/(家长|监护人)的职业/g, '$1职业');
  return normalized;
}

function _extract_student_keyword(text: string): string {
  const token = /([0-9A-Za-z_-]+|[\u4e00-\u9fff]{2,8})/;
  const patterns = [
    new RegExp(`(?:学生|同学|学号)\\s*${token.source}`),
    new RegExp(`(?:查看|查询|了解)\\s*${token.source}`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const keyword = match[1].trim();
      if (keyword.startsWith('的') || keyword.includes('学生') || keyword.includes('同学')
        || ['信息', '详细信息', '基本信息'].includes(keyword)) {
        continue;
      }
      /* 年份（19xx/20xx）不是学号，避免“查一下2026年春季的成绩”被当作学生查询。 */
      if (/^(19|20)\d{2}$/.test(keyword)) {
        continue;
      }
      return keyword;
    }
  }
  return '';
}

function _planner_prompt(registry: ToolRegistry): string {
  const tools: Array<Record<string, unknown>> = [];
  for (const tool of registry.list()) {
    /* 计划路径只执行只读工具；写工具必须经预览-确认流程，不进入规划器。 */
    if (Boolean(tool['write_action'])) continue;
    tools.push({
      name: tool['name'],
      description: tool['description'],
      parameters: tool['parameters'],
    });
  }
  const schema: Record<string, unknown> = {
    goal: '一句话描述要完成的查询目标',
    steps: [
      {
        id: '唯一的小写步骤名',
        tool: '工具名',
        arguments: { '参数': '值或 $步骤名.结果路径' },
        depends_on: ['前置步骤 id'],
        condition: '可选：exactly_one_student 或 student_found',
      },
    ],
  };
  return '你是“凯凯小兵”的任务规划器，不直接回答用户。\n'
    + '请把用户请求拆成最多 6 个只读工具步骤，并且只输出 JSON，不要 Markdown、解释或思维过程。\n'
    + '步骤必须按依赖顺序排列；涉及具体学生时先 students_search，再使用搜索结果中的 id。\n'
    + '涉及“所有学生”“每个学生”“学生家长”“全班分布”或需要比较多名学生时，优先使用 students_query 或 students_aggregate，不要逐个调用 student_get_profile。\n'
    + '如果搜索结果不唯一，依赖学生 id 的步骤使用 condition="exactly_one_student"。\n'
    + '工具结果引用格式为 $步骤id.结果字段[0].字段名。\n'
    + '\nJSON 格式示例：\n'
    + JSON.stringify(schema)
    + '\n\n可用工具：\n'
    + JSON.stringify(tools);
}

function _planner_input(text: string, context: string): string {
  if (context) {
    return `最近上下文：\n${context}\n\n当前请求：\n${text}`;
  }
  return text;
}

function _tool_calls_to_payload(response: ModelResponse): Record<string, unknown> {
  return {
    goal: '根据用户请求完成数据查询',
    steps: response.tool_calls.map((call, index) => ({
      id: `tool_step_${index + 1}`,
      tool: call.name,
      arguments: _parse_json(call.arguments || '{}'),
    })),
  };
}

function _parse_json(content: string): unknown {
  let text = String(content ?? '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
      }
    }
    throw new PlanningError('模型没有返回有效的 JSON 计划');
  }
}
