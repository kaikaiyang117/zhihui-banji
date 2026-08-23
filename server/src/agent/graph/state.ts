/* AGENT-01 LangGraph 状态定义（班小助 KaikaiState）。
 * 可序列化、可版本化；不保存 API Key、微信 Token、敏感字段或隐式思维链。
 */
import { Annotation } from '@langchain/langgraph';

import type { AgentPlan, PlanStep } from '../planner.js';

export const GRAPH_VERSION = 1;

export interface PlanStepResult {
  step: PlanStep;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface GraphState {
  graphVersion: number;
  sessionId: string;
  channel: string;
  actorId: string;
  text: string;
  attachment: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  directTool: [string, string, string] | null;
  plan: AgentPlan | null;
  executed: PlanStepResult[];
  failureCounts: Record<string, number>;
  replanCount: number;
  finalAnswer: string;
  halted: boolean;
  errorMessage: string;
}

export const StateAnnotation = Annotation.Root({
  graphVersion: Annotation<number>({
    reducer: (_current, value) => value ?? GRAPH_VERSION,
    default: () => GRAPH_VERSION,
  }),
  sessionId: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  channel: Annotation<string>({ reducer: (_a, b) => b, default: () => 'local' }),
  actorId: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  text: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  attachment: Annotation<Record<string, unknown> | null>({ reducer: (_a, b) => b ?? null, default: () => null }),
  messages: Annotation<Array<Record<string, unknown>>>({
    reducer: (a, b) => b ?? a ?? [],
    default: () => [],
  }),
  directTool: Annotation<[string, string, string] | null>({
    reducer: (_a, b) => b ?? null,
    default: () => null,
  }),
  plan: Annotation<AgentPlan | null>({
    reducer: (_a, b) => b ?? null,
    default: () => null,
  }),
  executed: Annotation<PlanStepResult[]>({
    reducer: (a, b) => b ?? a ?? [],
    default: () => [],
  }),
  failureCounts: Annotation<Record<string, number>>({
    reducer: (a, b) => ({ ...(a ?? {}), ...(b ?? {}) }),
    default: () => ({}),
  }),
  replanCount: Annotation<number>({
    reducer: (a, b) => b ?? a ?? 0,
    default: () => 0,
  }),
  finalAnswer: Annotation<string>({ reducer: (_a, b) => b ?? '', default: () => '' }),
  halted: Annotation<boolean>({ reducer: (_a, b) => b ?? false, default: () => false }),
  errorMessage: Annotation<string>({ reducer: (_a, b) => b ?? '', default: () => '' }),
});
