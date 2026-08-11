/* MIG-01 试验 C：LangGraph.js 能力验证。

验证项：
1. StateGraph + 条件边 + 确定性路由
2. 自定义流式事件（streamMode custom + config.writer）
3. SQLite checkpointer（独立临时库）线程检查点
4. “进程重启”后从同一检查点恢复（新图实例共享同一 DB）
5. interrupt 人工确认暂停；恢复后副作用（写入）恰好执行一次
6. 图版本号随状态持久化，跨实例一致
*/
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const results: { checks: { name: string; ok: boolean; detail: string }[]; total?: number; passed?: number; ok?: boolean } = { checks: [] };
function check(name: string, ok: boolean, detail = '') {
  results.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const State = Annotation.Root({
  graphVersion: Annotation<number>,
  steps: Annotation<string[]>({ reducer: (a, b) => (a ?? []).concat(b ?? []), default: () => [] }),
  writes: Annotation<number>({ reducer: (a, b) => (a ?? 0) + (b ?? 0), default: () => 0 }),
  needsConfirm: Annotation<boolean>,
  finalAnswer: Annotation<string>,
});

const GRAPH_VERSION = 7;

function buildGraph() {
  const graph = new StateGraph(State)
    .addNode('route', async (state) => {
      return { graphVersion: GRAPH_VERSION, needsConfirm: state.needsConfirm ?? false };
    })
    .addNode('ask_user', async (_state, config) => {
      const answer = await interrupt({ question: '是否执行写入？' });
      config.writer?.({ type: 'confirmation_received', answer });
      return { needsConfirm: false };
    })
    .addNode('do_write', async (_state, config) => {
      // 模拟带副作用的写入：恢复时不得重复执行
      config.writer?.({ type: 'write_executed' });
      return { writes: 1, steps: ['write-done'] };
    })
    .addNode('finish', async (state) => {
      return { finalAnswer: `完成，写入次数 ${state.writes}` };
    })
    .addConditionalEdges('route', (state) => (state.needsConfirm ? 'ask_user' : 'do_write'), {
      ask_user: 'ask_user',
      do_write: 'do_write',
    })
    .addEdge(START, 'route')
    .addEdge('ask_user', 'do_write')
    .addEdge('do_write', 'finish')
    .addEdge('finish', END);
  return graph;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig01-langgraph-'));
const checkpointDb = path.join(tmpDir, 'agent-checkpoints.db');

try {
  // ---------- 1. 条件边 + 普通执行（无确认） ----------
  {
    const saver = SqliteSaver.fromConnString(checkpointDb);
    const graph = buildGraph().compile({ checkpointer: saver });
    const result = await graph.invoke({ needsConfirm: false }, { configurable: { thread_id: 't-direct' } });
    check('条件边直达写入分支', result.finalAnswer === '完成，写入次数 1' && result.writes === 1,
      JSON.stringify(result.finalAnswer));
    check('图版本随状态持久化', result.graphVersion === GRAPH_VERSION);
  }

  // ---------- 2. 自定义流式事件 ----------
  {
    const saver = SqliteSaver.fromConnString(checkpointDb);
    const graph = buildGraph().compile({ checkpointer: saver });
    const events = [];
    for await (const event of await graph.stream({ needsConfirm: false }, {
      configurable: { thread_id: 't-stream' }, streamMode: ['updates', 'custom'],
    })) {
      const [mode, payload] = event;
      if (mode === 'custom') events.push({ type: 'custom', value: payload });
      else if (mode === 'updates') events.push({ type: 'update', node: Object.keys(payload)[0] });
    }
    const custom = events.filter((e) => e.type === 'custom').map((e) => e.value.type);
    const nodes = events.filter((e) => e.type === 'update').map((e) => e.node);
    check('自定义事件写入（write_executed）', custom.includes('write_executed'), custom.join(','));
    check('节点更新序列 route→do_write→finish',
      nodes.join(',') === 'route,do_write,finish', nodes.join(','));
  }

  // ---------- 3. interrupt 暂停 + 恢复 + 副作用幂等 ----------
  {
    const saver = SqliteSaver.fromConnString(checkpointDb);
    const graphA = buildGraph().compile({ checkpointer: saver });
    const runA = await graphA.invoke({ needsConfirm: true }, { configurable: { thread_id: 't-confirm' } }) as unknown as { __interrupt__?: Array<{ value?: unknown }> };
    check('interrupt 暂停在 ask_user', Boolean(runA.__interrupt__?.length),
      JSON.stringify(runA.__interrupt__?.[0]?.value ?? runA));

    const pending = await graphA.getState({ configurable: { thread_id: 't-confirm' } });
    check('挂起状态含中断信息', Boolean(pending.next?.length), `next=${pending.next}`);

    // “进程重启”：用同一个 SQLite 检查点新建图实例恢复
    const graphB = buildGraph().compile({ checkpointer: SqliteSaver.fromConnString(checkpointDb) });
    const runB = await graphB.invoke(new Command({ resume: '确认' }), { configurable: { thread_id: 't-confirm' } });
    check('恢复后写入恰好一次', runB.writes === 1, `writes=${runB.writes}`);
    check('恢复后最终回答正确', runB.finalAnswer === '完成，写入次数 1');

    const finalState = await graphB.getState({ configurable: { thread_id: 't-confirm' } });
    check('完成后状态一致（图版本保留）', finalState.values.graphVersion === GRAPH_VERSION);
  }

  // ---------- 4. 并发线程隔离 ----------
  {
    const saver = SqliteSaver.fromConnString(checkpointDb);
    const graph = buildGraph().compile({ checkpointer: saver });
    const [a, b] = await Promise.all([
      graph.invoke({ needsConfirm: false }, { configurable: { thread_id: 't-concurrent-a' } }),
      graph.invoke({ needsConfirm: false }, { configurable: { thread_id: 't-concurrent-b' } }),
    ]);
    check('并发线程互不串扰', a.writes === 1 && b.writes === 1 && a.steps.length === 1 && b.steps.length === 1,
      `a=${a.writes}/${a.steps.length} b=${b.writes}/${b.steps.length}`);
  }

  // ---------- 5. 检查点独立于业务库 ----------
  {
    const businessDb = path.join(tmpDir, 'workbench.db');
    const other = SqliteSaver.fromConnString(businessDb);
    const graph = buildGraph().compile({ checkpointer: other });
    await graph.invoke({ needsConfirm: false }, { configurable: { thread_id: 't-other' } });
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(businessDb, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
    db.close();
    check('检查点库只含 LangGraph 表（不触碰业务表）',
      tables.length > 0 && tables.every((t) => t.startsWith('checkpoint') || t.startsWith('writes')),
      tables.join(','));
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const passed = results.checks.filter((c) => c.ok).length;
results.total = results.checks.length;
results.passed = passed;
results.ok = passed === results.checks.length;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'langgraph-report.json'), JSON.stringify(results, null, 2));
console.log(`\nLangGraph 试验：${passed}/${results.checks.length} 通过`);
process.exit(results.ok ? 0 : 1);
