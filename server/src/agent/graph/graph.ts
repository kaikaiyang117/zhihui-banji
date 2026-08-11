/* AGENT-01 LangGraph 图：确定性意图路由 → 计划 → 执行 → 验证 → 纠错 → 回答。
 * 语义与 backend/app/agent/runner.py 完全一致，用 StateGraph 表达：
 *   load_context → route（直接工具 / 计划 / 模型循环）
 *   计划路径：plan → execute_plan →（恢复/重建一次）→ plan_final
 *   通用路径：model_loop（工具调用 + 一次重试 + 熔断）
 * 写入确认的 interrupt 节点由 AGENT-02 接入（当前写入走 createPendingAction）。
 */
import { END, START, StateGraph } from '@langchain/langgraph';

import { StateAnnotation, type GraphState } from './state.js';

export interface GraphNodeConfig {
  writer?: (chunk: unknown) => void;
}

export interface GraphRuntime {
  loadContext: (state: GraphState, config: GraphNodeConfig) => Promise<Partial<GraphState>> | Partial<GraphState>;
  applyDirect: (state: GraphState, config: GraphNodeConfig) => Promise<Partial<GraphState>> | Partial<GraphState>;
  createPlan: (state: GraphState, config: GraphNodeConfig) => Promise<Partial<GraphState>> | Partial<GraphState>;
  executePlan: (state: GraphState, config: GraphNodeConfig) => Promise<Partial<GraphState>> | Partial<GraphState>;
  planFinal: (state: GraphState, config: GraphNodeConfig) => Promise<Partial<GraphState>> | Partial<GraphState>;
  modelLoop: (state: GraphState, config: GraphNodeConfig) => Promise<Partial<GraphState>> | Partial<GraphState>;
  composeAnswer: (state: GraphState, config: GraphNodeConfig) => Promise<Partial<GraphState>> | Partial<GraphState>;
  route: (state: GraphState) => 'direct' | 'plan' | 'model';
}

/** 构建凯凯小兵状态图（未编译）；由 runner 以 checkpointer 编译。 */
export function buildKaikaiGraph(runtime: GraphRuntime) {
  return new StateGraph(StateAnnotation)
    .addNode('load_context', runtime.loadContext)
    .addNode('apply_direct', runtime.applyDirect)
    .addNode('create_plan', runtime.createPlan)
    .addNode('execute_plan_steps', runtime.executePlan)
    .addNode('plan_final', runtime.planFinal)
    .addNode('model_loop', runtime.modelLoop)
    .addNode('compose_answer', runtime.composeAnswer)
    .addConditionalEdges('load_context', runtime.route, {
      direct: 'apply_direct',
      plan: 'create_plan',
      model: 'model_loop',
    })
    .addEdge(START, 'load_context')
    .addEdge('apply_direct', 'model_loop')
    .addEdge('create_plan', 'execute_plan_steps')
    .addEdge('execute_plan_steps', 'plan_final')
    .addEdge('plan_final', 'compose_answer')
    .addEdge('model_loop', 'compose_answer')
    .addEdge('compose_answer', END);
}
