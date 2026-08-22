/* AGENT-01 凯凯 Runner：以 LangGraph 状态图表达模型+工具循环。
 * 公开 API（chat/chatStream）遵循统一 Agent 执行契约，
 * 内部节点复刻：确定性直接工具、计划（确定性/模型）、执行（条件/引用/一次重试）、
 * 空批量恢复一次、失败重建一次、重试熔断、最终回答流式。
 * 图内自定义事件（plan/plan_step/delta）通过 LangGraph config.writer 发射。
 */
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import fs from 'node:fs';
import path from 'node:path';

import type { GraphState } from './graph/state.js';
import { buildKaikaiGraph, type GraphNodeConfig, type GraphRuntime } from './graph/graph.js';
import { getDb } from '../services/context.js';
import {
  AgentPlanner, build_rule_plan, normalize_query_text, _is_class_student_analysis,
  type AgentPlan, type PlanStep,
} from './planner.js';
import { OpenAICompatibleClient, type ModelResponse } from './modelClient.js';
import { systemPrompt } from './prompt.js';
import { SessionStore } from './sessionStore.js';
import { buildRegistry, ToolRegistry, ToolError } from './toolRegistry.js';
import { invokeTool, recordModelUsage, recordToolFailure } from './agentService.js';
import { handleConfirmation } from './actions.js';

export interface RunnerOptions {
  modelClient?: OpenAICompatibleClient;
  sessionStore?: SessionStore;
  maxTurns?: number;
}

type EmitFn = (payload: Record<string, unknown>) => void;

export class AgentRunner {
  modelClient: OpenAICompatibleClient;
  sessionStore: SessionStore;
  maxTurns: number;

  constructor(options: RunnerOptions = {}) {
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
    this.sessionStore = options.sessionStore ?? new SessionStore();
    this.maxTurns = Math.max(1, Math.min(options.maxTurns ?? 5, 10));
  }

  static _callTool(name: string, rawArguments: string, channel: string, actorId: string, sessionId = ''): Record<string, unknown> {
    let argumentsValue: unknown;
    try {
      argumentsValue = parseToolArguments(rawArguments);
    } catch {
      const message = '工具参数不是有效 JSON';
      recordToolFailure(channel, actorId, name, {}, 'error', message);
      return toolError('invalid_arguments', message, true);
    }
    if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) {
      const message = '工具参数必须是对象';
      recordToolFailure(channel, actorId, name, {}, 'error', message);
      return toolError('invalid_arguments', message, true);
    }
    try {
      return invokeTool(name, argumentsValue as Record<string, unknown>, {
        channel, actorId, sessionId,
      }) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ToolError) {
        return toolError(error.code, error.message, Boolean(error.retryable), Boolean(error.autoRetry));
      }
      throw error;
    }
  }

  private executeToolWithRetry(
    name: string, rawArguments: string, channel: string, actorId: string,
    failureCounts: Record<string, number>, sessionId = '',
  ): Record<string, unknown> {
    const key = `${name}:${rawArguments}`;
    if ((failureCounts[key] ?? 0) >= 1) {
      const message = '同一个工具调用已经失败并自动重试过一次，停止继续重复调用。';
      recordToolFailure(channel, actorId, name, {}, 'retry_exhausted', message);
      return toolError('retry_exhausted', message, false);
    }
    const result = AgentRunner._callTool(name, rawArguments, channel, actorId, sessionId);
    const error = result.error as Record<string, unknown> | undefined;
    if (!error) return result;
    failureCounts[key] = 1;
    if (!Boolean(error.autoRetry ?? error.auto_retry)) return result;
    const retryResult = AgentRunner._callTool(name, rawArguments, channel, actorId, sessionId);
    if (!retryResult.error) return retryResult;
    (retryResult.error as Record<string, unknown>).retry_attempts = 1;
    return retryResult;
  }

  private recordUsage(
    sessionId: string, channel: string, actorId: string, status: string,
    started: number, response: ModelResponse | null | undefined, error = '',
  ): void {
    const config = (this.modelClient as unknown as { config?: { model?: string } }).config;
    recordModelUsage({
      sessionId, channel, actorId, model: String(config?.model ?? ''),
      status, durationMs: Math.max(0, Math.round(Date.now() - started)),
      usage: response?.usage ?? null, errorMessage: error,
    });
  }

  private planner(state: GraphState): AgentPlanner {
    return new AgentPlanner(this.modelClient, (response, started, status, error) =>
      this.recordUsage(state.sessionId, state.channel, state.actorId, status, started, response, error));
  }

  /** 组装 graph runtime 节点。 */
  private runtime(registry: ToolRegistry): GraphRuntime {
    const self = this;
    const planReasoningBySession = new Map<string, string>();
    const emitFor = (config: GraphNodeConfig): EmitFn =>
      (payload) => config.writer?.(payload);

    const emitDelta = (emit: EmitFn, content: string): void => {
      emit({ type: 'delta', content });
    };
    const emitPlanEvent = (emit: EmitFn, plan: { goal: string; steps: ReadonlyArray<{ id: string; tool: string }> }, status: string): void => {
      emit({
        type: 'plan', status, goal: plan.goal,
        steps: plan.steps.map((step) => ({ id: step.id, label: stepLabel(step.tool), status: 'pending' })),
      });
    };
    const emitPlanStep = (emit: EmitFn, step: { id: string; tool: string }, status: string, message = ''): void => {
      const payload: Record<string, unknown> = {
        type: 'plan_step', id: step.id, label: stepLabel(step.tool), status,
      };
      if (message) payload.message = message;
      emit(payload);
    };

    const emitToolEvent = (
      emit: EmitFn, id: string, name: string, status: string,
      input: Record<string, unknown>, output?: Record<string, unknown>,
    ): void => {
      const payload: Record<string, unknown> = {
        type: 'tool', id, name, status, input,
      };
      if (output !== undefined) payload.output = output;
      emit(payload);
    };

    const runSteps = (
      emit: EmitFn, state: GraphState, plan: AgentPlan,
      failureCounts: Record<string, number>,
    ): GraphState['executed'] => {
      const results: Record<string, Record<string, unknown>> = {};
      const steps: GraphState['executed'] = [];
      for (const step of plan.steps) {
        if (!conditionMatches(step, results)) {
          emitPlanStep(emit, step, 'skipped', conditionFailureMessage(step, results));
          continue;
        }
        emitPlanStep(emit, step, 'running');
        let argumentsValue: Record<string, unknown> = {};
        let result: Record<string, unknown>;
        try {
          argumentsValue = resolveReferences(step.arguments, results) as Record<string, unknown>;
          emitToolEvent(emit, step.id, step.tool, 'running', argumentsValue);
          result = self.executeToolWithRetry(
            step.tool, JSON.stringify(argumentsValue), state.channel, state.actorId,
            failureCounts, state.sessionId);
        } catch (error) {
          result = toolError('plan_error', String((error as Error).message), false);
          recordToolFailure(state.channel, state.actorId, step.tool, {}, 'error', String((error as Error).message));
          argumentsValue = {};
        }
        results[step.id] = result;
        steps.push({ step, arguments: argumentsValue, result });
        const error = result.error as Record<string, unknown> | undefined;
        emitToolEvent(emit, step.id, step.tool, error ? 'error' : 'completed', argumentsValue, result);
        emitPlanStep(emit, step, error ? 'error' : 'completed', String(error?.message ?? ''));
      }
      return steps;
    };

    return {
      loadContext: (state) => {
        const sessionMessages = self.sessionStore.loadOwned(
          state.sessionId, state.actorId, state.channel);
        const resolvedReference = resolveFollowupStudentReference(state.text, sessionMessages);
        const systemMessage = { role: 'system', content: systemPrompt() };
        let messages: Array<Record<string, unknown>>;
        if (!sessionMessages.length || String(sessionMessages[0]?.role) !== 'system') {
          messages = [systemMessage, ...sessionMessages];
        } else {
          messages = [systemMessage, ...sessionMessages.slice(1)];
        }
        if (resolvedReference.reference) {
          messages.push({
            role: 'system',
            content: `本轮请求中的“这个学生”已解析为上一轮提到的学生：${resolvedReference.reference}。请沿用这个学生，不要重新猜测其他学生。`,
            context_summary: true,
            student_context_reference: true,
          });
        }
        const attachment = state.attachment;
        if (attachment?.file_id) {
          const candidates = Array.isArray(attachment.candidate_modules)
            ? attachment.candidate_modules
              .slice(0, 4)
              .map((item) => {
                const candidate = item as Record<string, unknown>;
                return `${String(candidate.module ?? '')}${candidate.reason ? `（${String(candidate.reason).slice(0, 80)}）` : ''}`;
              })
              .filter(Boolean)
            : [];
          const sheets = Array.isArray(attachment.sheets)
            ? attachment.sheets.slice(0, 10).map(String).join('、')
            : '';
          messages.push({
            role: 'system',
            content: [
              '当前会话有一个用户刚上传的 Excel 附件。',
              `文件标识：${String(attachment.file_id)}`,
              attachment.filename ? `文件名：${String(attachment.filename).slice(0, 120)}` : '',
              sheets ? `工作表：${sheets}` : '',
              candidates.length ? `系统识别的可能模块：${candidates.join('、')}` : '',
              '如需继续处理，请先向用户说明识别结果；预览和写入必须由网页导入卡片完成，不能绕过确认直接写入。',
            ].filter(Boolean).join('\n'),
            context_summary: true,
            excel_attachment_context: true,
          });
        }
        messages.push({ role: 'user', content: state.text });
        return {
          messages,
          text: resolvedReference.text,
          directTool: inferDirectTool(resolvedReference.text),
        };
      },
      route: (state) => (state.directTool ? 'direct' : (shouldAttemptModelPlan(state.text) ? 'plan' : 'model')),
      applyDirect: (state, config) => {
        const [toolName, toolArguments, toolCallId] = state.directTool!;
        const emit = emitFor(config);
        const input = parseToolInput(toolArguments);
        emitToolEvent(emit, toolCallId, toolName, 'running', input);
        const messages = [...state.messages];
        messages.push({
          role: 'assistant', content: null, reasoning_content: '',
          tool_calls: [{ id: toolCallId, type: 'function', function: { name: toolName, arguments: toolArguments } }],
        });
        const result = AgentRunner._callTool(toolName, toolArguments, state.channel, state.actorId, state.sessionId);
        emitToolEvent(emit, toolCallId, toolName, result.error ? 'error' : 'completed', input, result);
        messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) });
        return { messages };
      },
      createPlan: async (state) => {
        const availableRegistry = registry.forChannel(state.channel);
        let plan = build_rule_plan(state.text, availableRegistry);
        planReasoningBySession.set(state.sessionId, '');
        if (!plan && shouldAttemptModelPlan(state.text)) {
          try {
            const planner = self.planner(state);
            plan = await planner.create(
              state.text, availableRegistry, recentContext(state.messages));
            planReasoningBySession.set(state.sessionId, planner.lastReasoningContent);
          } catch {
            plan = null;
          }
        }
        if (!plan) return { plan: null };
        return { plan: validatePlanForRequest(plan, state.text, availableRegistry) };
      },
      executePlan: async (state, config) => {
        const emit = emitFor(config);
        if (!state.plan) return {};
        const failureCounts = { ...state.failureCounts };
        let replanCount = state.replanCount;

        emitPlanEvent(emit, state.plan, 'started');
        let executed = runSteps(emit, state, state.plan, failureCounts);
        if (hasRetryExhausted(executed)) {
          return { executed, finalAnswer: toolFailureMessage(), halted: true };
        }
        const availableRegistry = registry.forChannel(state.channel);
        const recovery = recoveryPlanForEmptyBatch(state.text, state.plan, executed, availableRegistry);
        if (recovery) {
          emitPlanEvent(emit, recovery, 'replanned');
          executed = runSteps(emit, state, recovery, failureCounts);
        }
        if (shouldReplan(executed) && replanCount < 1) {
          try {
            const planner = self.planner(state);
            const replanned = await planner.create(
              state.text, availableRegistry,
              recentContext(state.messages) + '\n' + planFailureContext(executed));
            planReasoningBySession.set(state.sessionId, planner.lastReasoningContent);
            replanCount += 1;
            emitPlanEvent(emit, replanned, 'replanned');
            executed = runSteps(emit, state, replanned, failureCounts);
          } catch {
            // 重建失败按原计划结果继续
          }
          if (hasRetryExhausted(executed)) {
            return { executed, finalAnswer: toolFailureMessage(), halted: true, replanCount };
          }
        }
        return { executed, failureCounts, replanCount };
      },
      planFinal: async (state, config) => {
        const emit = emitFor(config);
        if (state.halted) return {};
        const failureAnswer = planFailureAnswer(state.plan, state.executed);
        if (failureAnswer) {
          emitDelta(emit, failureAnswer);
          return { finalAnswer: failureAnswer };
        }
        const started = Date.now();
        let response: ModelResponse | null = null;
        let contentParts: string[] = [];
        try {
          for await (const event of self.modelClient.iter_complete(
            planFinalMessages(
              state.messages, state.executed, planReasoningBySession.get(state.sessionId) ?? ''))) {
            if (event.content) {
              contentParts.push(event.content);
              emitDelta(emit, event.content);
            }
            if (event.response) response = event.response;
          }
        } catch (error) {
          self.recordUsage(state.sessionId, state.channel, state.actorId, 'error', started,
            null, String((error as Error).message));
          throw error;
        }
        self.recordUsage(state.sessionId, state.channel, state.actorId, 'success', started, response);
        if (!response) throw new Error('模型流式响应缺少最终结果');
        if (response.tool_calls && response.tool_calls.length > 0) {
          return {
            finalAnswer: contentParts.join('').trim() || fallbackPlanAnswer(state.executed),
          };
        }
        const answer = (response.content ?? '').trim()
          || contentParts.join('').trim() || fallbackPlanAnswer(state.executed);
        return { finalAnswer: answer };
      },
      modelLoop: async (state, config) => {
        const emit = emitFor(config);
        const messages = [...state.messages];
        const failureCounts = { ...state.failureCounts };
        let finalAnswer = '';
        let halted = false;
        for (let turn = 0; turn < self.maxTurns; turn += 1) {
          const started = Date.now();
          let response: ModelResponse | null = null;
          try {
            for await (const event of self.modelClient.iter_complete(
              messages, registry.modelTools(state.channel))) {
              if (event.content) emitDelta(emit, event.content);
              if (event.response) response = event.response;
            }
          } catch (error) {
            self.recordUsage(state.sessionId, state.channel, state.actorId, 'error', started,
              null, String((error as Error).message));
            throw error;
          }
          if (!response) {
            self.recordUsage(state.sessionId, state.channel, state.actorId, 'error', started,
              null, '模型流式响应缺少最终结果');
            throw new Error('模型流式响应缺少最终结果');
          }
          self.recordUsage(state.sessionId, state.channel, state.actorId, 'success', started, response);
          if (!response.tool_calls || response.tool_calls.length === 0) {
            finalAnswer = (response.content ?? '').trim() || '模型没有返回可显示的内容。';
            messages.push({ role: 'assistant', content: finalAnswer });
            break;
          }
          messages.push(assistantToolMessage(response));
          let haltMessage = '';
          for (const call of response.tool_calls) {
            emitToolEvent(emit, call.id || `tool-${turn}`, call.name, 'running', parseToolInput(call.arguments));
            const result = self.executeToolWithRetry(
              call.name, call.arguments, state.channel, state.actorId, failureCounts, state.sessionId);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            emitToolEvent(
              emit, call.id || `tool-${turn}`, call.name,
              result.error ? 'error' : 'completed', parseToolInput(call.arguments), result,
            );
            if ((result.error as Record<string, unknown> | undefined)?.code === 'retry_exhausted') {
              haltMessage = toolFailureMessage();
              break;
            }
          }
          if (haltMessage) {
            messages.push({ role: 'assistant', content: haltMessage });
            finalAnswer = haltMessage;
            halted = true;
            break;
          }
        }
        if (!finalAnswer) {
          finalAnswer = '这次查询步骤太多，请缩小问题范围后重试。';
          messages.push({ role: 'assistant', content: finalAnswer });
        }
        return { messages, finalAnswer, halted, failureCounts };
      },
      composeAnswer: (state) => {
        const messages = [...state.messages];
        if (state.directTool || state.plan) {
          messages.push({ role: 'assistant', content: state.finalAnswer });
        }
        self.sessionStore.save(state.sessionId, messages, {
          actorId: state.actorId, channel: state.channel,
        });
        return { messages };
      },
    };
  }

  private buildGraph(): Promise<{
    invoke: (input: GraphState, sessionId: string) => Promise<GraphState>;
    stream: (input: GraphState, sessionId: string) => Promise<AsyncGenerator<unknown>>;
    close: () => void;
  }> {
    const registry = buildRegistry();
    const runtime = this.runtime(registry);
    return (async () => {
      const dataDir = getDb().paths.dataDir;
      const checkpointsPath = path.join(dataDir, 'agent-checkpoints.db');
      fs.mkdirSync(dataDir, { recursive: true });
      const checkpointer = SqliteSaver.fromConnString(checkpointsPath);
      const graph = buildKaikaiGraph(runtime).compile({ checkpointer });
      return {
        invoke: async (input, sessionId) =>
          (await graph.invoke(input, { configurable: { thread_id: sessionId } })) as GraphState,
        stream: async (input, sessionId) => {
          const stream = await graph.stream(input, {
            configurable: { thread_id: sessionId }, streamMode: ['custom'],
          });
          return stream as unknown as AsyncGenerator<unknown>;
        },
        close: () => {
          if (checkpointer.db.open) checkpointer.db.close();
        },
      };
    })();
  }

  private initial(sessionId: string, channel: string, actorId: string, text: string, attachment: GraphState['attachment'] = null): GraphState {
    return {
      graphVersion: 1, sessionId, channel, actorId, text, attachment,
      messages: [], directTool: null, plan: null, executed: [],
      failureCounts: {}, replanCount: 0, finalAnswer: '', halted: false, errorMessage: '',
    };
  }

  async chat(sessionId: string, text: string, options: { channel?: string; actorId?: string; attachment?: GraphState['attachment'] } = {}): Promise<string> {
    const channel = options.channel ?? 'local';
    const actorId = options.actorId ?? '';
    const input = String(text ?? '').trim();
    if (!input) return '请输入要查询的内容。';
    const handled = handleConfirmation(input, { sessionId, actorId, channel });
    if (handled[0]) return handled[1];
    const graph = await this.buildGraph();
    try {
      const result = await graph.invoke(this.initial(sessionId, channel, actorId, input, options.attachment ?? null), sessionId);
      return result.finalAnswer || '请输入要查询的内容。';
    } finally {
      graph.close();
    }
  }

  async *chatStream(sessionId: string, text: string, options: { channel?: string; actorId?: string; attachment?: GraphState['attachment'] } = {}):
    AsyncGenerator<Record<string, unknown>> {
    const channel = options.channel ?? 'local';
    const actorId = options.actorId ?? '';
    const input = String(text ?? '').trim();
    if (!input) {
      yield { type: 'delta', content: '请输入要查询的内容。' };
      return;
    }
    const handled = handleConfirmation(input, { sessionId, actorId, channel });
    if (handled[0]) {
      yield { type: 'delta', content: handled[1] };
      return;
    }
    const graph = await this.buildGraph();
    try {
      const stream = await graph.stream(this.initial(sessionId, channel, actorId, input, options.attachment ?? null), sessionId);
      let finalAnswer = '';
      for await (const event of stream) {
        const payload = (Array.isArray(event) ? event[1] : event) as Record<string, unknown>;
        if (payload.type === 'delta') {
          finalAnswer += String(payload.content ?? '');
          yield { type: 'delta', content: String(payload.content ?? '') };
        } else if (payload.type === 'plan' || payload.type === 'plan_step' || payload.type === 'tool') {
          yield payload as Record<string, unknown>;
        }
      }
      if (!finalAnswer) {
        yield { type: 'delta', content: '查询未返回结果，请稍后重试。' };
      }
    } finally {
      graph.close();
    }
  }
}

/* ---------------- 内部辅助（与 runner.py 语义一致） ---------------- */

function toolError(code: string, message: string, retryable: boolean, autoRetry = false): Record<string, unknown> {
  return { error: { code, message, retryable, auto_retry: autoRetry } };
}

function parseToolArguments(rawArguments: string): unknown {
  let text = String(rawArguments ?? '{}').trim();
  try {
    return JSON.parse(text);
  } catch {
    text = text.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    try {
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${text});`)();
    } catch {
      throw new Error('工具参数不是有效 JSON');
    }
  }
}

function parseToolInput(rawArguments: string): Record<string, unknown> {
  try {
    const value = parseToolArguments(rawArguments);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function inferDirectTool(text: string): [string, string, string] | null {
  const classTerms = ['班级', '我们班', '本班', '班里', '班上', '全班'];
  if (classTerms.some((term) => text.includes(term))
    && ['学生', '同学', '人数', '总数', '人'].some((term) => text.includes(term))
    && ['多少', '几', '人数', '总数', '总共', '共有'].some((term) => text.includes(term))) {
    return ['class_student_count', '{}', 'direct-class-student-count'];
  }
  if (classTerms.some((term) => text.includes(term))
    && ['考勤', '出勤', '迟到', '请假', '缺勤'].some((term) => text.includes(term))) {
    return ['attendance_summary', '{}', 'direct-class-attendance-summary'];
  }
  if (classTerms.some((term) => text.includes(term))
    && ['成绩', '分数', '考试', '排名'].some((term) => text.includes(term))) {
    return ['scores_summary', '{}', 'direct-class-scores-summary'];
  }
  if (['待办', '逾期', '跟进任务'].some((term) => text.includes(term))
    && !['创建', '添加', '新建'].some((term) => text.includes(term))) {
    return ['tasks_list', '{}', 'direct-tasks-list'];
  }
  if (['家校沟通', '家长联系', '家访记录'].some((term) => text.includes(term))) {
    return ['communications_list', '{}', 'direct-communications-list'];
  }
  if (['校历', '上课日', '放假', '调休', '节假日', '考试安排'].some((term) => text.includes(term))) {
    return ['school_calendar_query', '{}', 'direct-school-calendar-query'];
  }
  return null;
}

function shouldAttemptModelPlan(text: string): boolean {
  return ['查询', '查看', '统计', '分析', '有没有', '是否', '最近', '详细',
    '学生', '同学', '家长', '监护人', '职业', '分布', '所有', '每个',
    '成绩', '考勤', '任务', '沟通', '校历', '上课日', '放假', '调休', '节假日',
  ].some((term) => text.includes(term));
}

function recentContext(messages: Array<Record<string, unknown>>): string {
  const context: string[] = [];
  for (const message of messages.slice(-8)) {
    const role = String(message.role ?? '');
    const content = message.content;
    if ((role === 'user' || role === 'assistant') && content) {
      context.push(`${role}: ${String(content).slice(0, 500)}`);
    }
  }
  return context.join('\n');
}

function resolveFollowupStudentReference(
  text: string, messages: Array<Record<string, unknown>>,
): { text: string; reference: string } {
  const markerPattern = /(?:这个学生|该学生|此学生|这名学生|这个同学|该同学)/;
  if (!markerPattern.test(text)) return { text, reference: '' };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user'
      && !(message.role === 'system' && message.context_summary && !message.student_context_reference)) {
      continue;
    }
    const reference = extractStudentReference(String(message.content ?? ''));
    if (!reference) continue;
    return {
      text: text.replace(/(?:这个学生|该学生|此学生|这名学生|这个同学|该同学)/g, reference),
      reference,
    };
  }
  return { text, reference: '' };
}

function extractStudentReference(text: string): string {
  const explicitId = /(?:学号|学生编号|学生学号|编号)\s*[:：]?\s*([0-9A-Za-z_-]+)/i.exec(text)?.[1] ?? '';
  if (isStudentReference(explicitId)) return explicitId;

  const candidates = [
    /(?:查看|查询|了解)(?:一下|下)?\s*(?:学生|同学)?\s*([0-9A-Za-z_-]+|[\u4e00-\u9fff]{2,4})/i,
    /(?:学生|同学)\s*([0-9A-Za-z_-]+|[\u4e00-\u9fff]{2,4})/i,
  ];
  for (const pattern of candidates) {
    const candidate = pattern.exec(text)?.[1] ?? '';
    if (isStudentReference(candidate)) return candidate;
  }
  return '';
}

function isStudentReference(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || [
    '这个', '那个', '该', '学生', '同学', '信息', '情况', '最近', '近期', '考勤', '出勤',
    '迟到', '请假', '缺勤', '成绩', '考试', '待办', '任务', '沟通', '档案', '表现',
  ].includes(candidate)) {
    return false;
  }
  if (/^(19|20)\d{2}$/.test(candidate)) return false;
  return /^[0-9A-Za-z_-]+$/.test(candidate) || /^[\u4e00-\u9fff]{2,4}$/.test(candidate);
}

function conditionMatches(step: PlanStep, results: Record<string, Record<string, unknown>>): boolean {
  if (!step.condition) return true;
  if (!step.depends_on || step.depends_on.length === 0) return false;
  const source = results[step.depends_on[0]] ?? {};
  const students = source.students;
  if (!Array.isArray(students)) return false;
  if (step.condition === 'exactly_one_student') return students.length === 1;
  if (step.condition === 'student_found') return students.length > 0;
  return false;
}

function conditionFailureMessage(step: PlanStep, results: Record<string, Record<string, unknown>>): string {
  const source = step.depends_on?.[0] ? results[step.depends_on[0]] : undefined;
  const students = source?.students;
  if (!Array.isArray(students) || students.length === 0) return '未找到匹配的学生';
  if (step.condition === 'exactly_one_student' && students.length > 1) {
    return '匹配到多名学生，无法确定具体对象';
  }
  return '前置条件未满足';
}

function resolveReferences(value: unknown, results: Record<string, Record<string, unknown>>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, results));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveReferences(item, results);
    }
    return out;
  }
  if (typeof value !== 'string' || !value.startsWith('$')) return value;
  const tokens = value.slice(1).match(/[^.\[\]]+|\[\d+\]/g) ?? [];
  const parts = tokens.map((token) => (token.startsWith('[') ? token.slice(1, -1) : token));
  if (!parts.length || !(parts[0] in results)) throw new Error(`找不到计划引用：${value}`);
  let current: unknown = results[parts[0]];
  for (const part of parts.slice(1)) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      const index = Number(part);
      if (index >= current.length) throw new Error(`计划引用超出范围：${value}`);
      current = current[index];
    } else if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>;
      const alias = part === 'student_id' ? 'id' : (part === 'id' ? 'student_id' : '');
      if (part in record) {
        current = record[part];
      } else if (alias && alias in record) {
        current = record[alias];
      } else {
        throw new Error(`计划引用路径不存在：${value}`);
      }
    } else {
      throw new Error(`计划引用路径不存在：${value}`);
    }
  }
  return current;
}

function planToolMessages(executed: GraphState['executed']): Array<Record<string, unknown>> {
  if (!executed.length) return [];
  const calls = executed.map((item) => ({
    id: `plan-${item.step.id}`,
    type: 'function',
    function: { name: item.step.tool, arguments: JSON.stringify(item.arguments) },
  }));
  const messages: Array<Record<string, unknown>> = [{
    role: 'assistant', content: '已按计划执行查询步骤。', reasoning_content: '', tool_calls: calls,
  }];
  for (const item of executed) {
    messages.push({
      role: 'tool', tool_call_id: `plan-${item.step.id}`,
      content: JSON.stringify(item.result),
    });
  }
  return messages;
}

function planFinalMessages(
  messages: Array<Record<string, unknown>>,
  executed: GraphState['executed'],
  reasoningContent: string,
): Array<Record<string, unknown>> {
  const toolMessages = planToolMessages(executed);
  if (toolMessages.length > 0) toolMessages[0].reasoning_content = reasoningContent;
  if (!messages.length) return toolMessages;
  return [
    messages[0],
    {
      role: 'system',
      content: '本轮查询计划已经执行完成。请只根据工具结果生成最终中文回答，不要再次调用工具，不要输出 DSML、XML 或工具协议标记。',
    },
    ...messages.slice(1),
    ...toolMessages,
  ];
}

function validatePlanForRequest(plan: AgentPlan, text: string, registry: ToolRegistry): AgentPlan {
  if (!_is_class_student_analysis(normalize_query_text(text))) return plan;
  if (plan.steps.some((step) => step.tool === 'students_search' || step.tool === 'student_get_profile')) {
    const corrected = build_rule_plan(text, registry);
    if (corrected) return corrected;
  }
  return plan;
}

function recoveryPlanForEmptyBatch(
  text: string, plan: AgentPlan, executed: GraphState['executed'], registry: ToolRegistry,
): AgentPlan | null {
  if (!_is_class_student_analysis(normalize_query_text(text))) return null;
  for (const item of executed) {
    const step = item.step;
    const result = item.result;
    if (step.tool === 'students_search') {
      const corrected = build_rule_plan(text, registry);
      return corrected && corrected !== plan ? corrected : null;
    }
    if (step.tool === 'students_query'
      && (item.arguments as Record<string, unknown>).keyword
      && Number((result as Record<string, unknown>).total_count ?? 0) === 0) {
      const corrected = build_rule_plan(text, registry);
      return corrected && corrected !== plan ? corrected : null;
    }
  }
  return null;
}

function hasRetryExhausted(executed: GraphState['executed']): boolean {
  return executed.some((item) =>
    (item.result.error as Record<string, unknown> | undefined)?.code === 'retry_exhausted');
}

function shouldReplan(executed: GraphState['executed']): boolean {
  const codes = new Set([
    'plan_error', 'invalid_arguments', 'execution_error', 'execution_failed',
    'tool_error', 'unknown_tool',
  ]);
  return executed.some((item) => {
    const error = item.result.error as Record<string, unknown> | undefined;
    return error && codes.has(String(error.code));
  });
}

function planFailureContext(executed: GraphState['executed']): string {
  const failures: string[] = [];
  for (const item of executed) {
    const error = item.result.error as Record<string, unknown> | undefined;
    if (error) {
      failures.push(`步骤 ${item.step.id}（${item.step.tool}）失败：${error.code}，${error.message}`);
    }
  }
  return `上一次计划执行失败，请修正后重新规划：\n${failures.join('\n')}`;
}

function fallbackPlanAnswer(executed: GraphState['executed']): string {
  if (!executed.length) return '没有找到可执行的查询步骤。';
  for (const item of executed) {
    const result = item.result;
    if (item.step.tool === 'students_search' && 'students' in result) {
      const students = (result as { students?: Array<Record<string, unknown>> }).students;
      if (!students || !students.length) return '没有找到匹配的学生。';
      if (students.length > 1) {
        const names = students.slice(0, 5)
          .map((row) => String(row.姓名 ?? row.学号 ?? '')).join('、');
        return `找到多名匹配学生：${names}，请说明具体学生。`;
      }
    }
  }
  return '查询已完成，但模型没有返回可显示的回答。';
}

function planFailureAnswer(
  plan: AgentPlan | null, executed: GraphState['executed'],
): string {
  for (const item of executed) {
    const error = item.result.error as Record<string, unknown> | undefined;
    if (error) {
      const message = String(error.message ?? '').trim();
      if (item.step.tool === 'students_search') {
        return message
          ? `搜索学生时遇到问题：${message}。请补充准确的学号或姓名。`
          : '搜索学生时遇到问题，请补充准确的学号或姓名。';
      }
      return message
        ? `${stepLabel(item.step.tool)}时遇到问题：${message}。请检查查询条件后重试。`
        : `${stepLabel(item.step.tool)}时遇到问题，请检查查询条件后重试。`;
    }
    if (item.step.tool !== 'students_search') continue;
    const students = item.result.students;
    if (!Array.isArray(students) || students.length === 0) {
      return '没有找到匹配的学生。请提供准确的学号或姓名，我再继续查询。';
    }
    if (students.length > 1) {
      const names = students.slice(0, 5)
        .map((row) => String(row.姓名 ?? row.学号 ?? '')).filter(Boolean).join('、');
      return names
        ? `找到多名匹配学生：${names}。请提供准确的学号或姓名。`
        : '找到多名匹配学生，请提供准确的学号或姓名。';
    }
  }

  if (plan && executed.length < plan.steps.length
    && plan.steps.some((step) => step.condition && !executed.some((item) => item.step.id === step.id))) {
    return '没有找到唯一匹配的学生，因此未继续查询。请提供准确的学号或姓名。';
  }
  return '';
}

function toolFailureMessage(): string {
  return '凯凯尝试查询时工具连续失败，已停止重复调用。请换一种说法，或稍后再试。';
}

function assistantToolMessage(response: ModelResponse): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: response.content ?? null,
    reasoning_content: response.reasoning_content ?? '',
    tool_calls: (response.tool_calls ?? []).map((call) => ({
      id: call.id, type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  };
  return message;
}

function stepLabel(tool: string): string {
  const labels: Record<string, string> = {
    students_search: '搜索学生', student_get_profile: '查询学生档案',
    student_get_timeline: '整理学生时间线', attendance_summary: '查询考勤记录',
    scores_summary: '查询成绩记录', tasks_list: '查询待办任务',
    communications_list: '查询家校沟通', class_student_count: '统计班级人数',
    students_query: '批量查询学生信息', students_aggregate: '统计学生分布',
    school_calendar_query: '查询校历',
  };
  return labels[tool] ?? tool;
}
