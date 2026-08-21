import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateParentReplyDraft } from '../../src/agent/parentReplyDrafter.js';
import { WorkbenchDb } from '../../src/db/connection.js';
import { setDatabase } from '../../src/services/context.js';
import { prepareParentReplyContext } from '../../src/services/parentReply.js';

let tempDir: string;
let db: WorkbenchDb;

function seed(): void {
  const conn = db.connInstance;
  conn.prepare("UPDATE terms SET name='2026春季学期', start_date='2026-02-23', end_date='2026-07-10', status='进行中' WHERE id=1").run();
  conn.prepare('INSERT INTO students(学号, 姓名, 性别, 家庭住址, 监护人电话) VALUES(?,?,?,?,?)')
    .run('S001', '测试学生', '女', '不应进入模型的家庭地址', '13800138000');
  conn.prepare(
    `INSERT INTO student_enrollments(student_id, class_id, term_id, status)
     VALUES(1, 1, 1, '在读')`,
  ).run();
  conn.prepare(
    `INSERT INTO exam_records(student_id, class_id, term_id, exam_name, exam_date, subject, score)
     VALUES(1, 1, 1, '四月月考', '2026-04-10', '语文', 86)`,
  ).run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-reply-'));
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

describe('家长消息回复助手', () => {
  it('把作业争议分流为核实后回复，并只读取脱敏事实', () => {
    const context = prepareParentReplyContext({
      studentId: 1,
      parentMessage: '孩子连续四天写作业到晚上十一点，是不是作业太多了？',
      teacherContext: '',
    });
    const serialized = JSON.stringify(context);
    expect(context.response_level).toBe('verify');
    expect(context.unknowns.join('')).toContain('各科实际用时');
    expect(context.questions_to_verify.join('')).toContain('几点开始');
    expect(context.compliance_assessment.state).toBe('possible_conflict');
    expect(context.compliance_assessment.policy_findings[0]?.id).toBe('homework_sleep');
    expect(context.compliance_assessment.policy_findings[0]?.evidence_status).toBe('单方陈述');
    expect(context.compliance_assessment.complaint_signal.level).toBe('none');
    expect(serialized).toContain('四月月考');
    expect(serialized).not.toContain('不应进入模型的家庭地址');
    expect(serialized).not.toContain('13800138000');
  });

  it('没有投诉关键词时也能根据行为本身升级不当惩戒风险', () => {
    const context = prepareParentReplyContext({
      studentId: 1,
      parentMessage: '孩子说老师今天扇了他一巴掌，脸到现在还是红的。',
      teacherContext: '',
    });
    expect(context.response_level).toBe('escalate');
    expect(context.compliance_assessment.state).toBe('escalate');
    expect(context.compliance_assessment.policy_findings.map(item => item.id)).toContain('improper_discipline');
    expect(context.compliance_assessment.complaint_signal.level).toBe('none');
    expect(context.compliance_assessment.recommended_actions.join('')).toContain('学校负责人');
  });

  it('AI 可依据完整语义补充登记规则，但必须引用原文且不能降低等级', async () => {
    const result = await generateParentReplyDraft({
      studentId: 1,
      parentMessage: '孩子回来说，老师当着全班同学的面把他推倒在地。',
      teacherContext: '目前只收到家长陈述，尚未向当事人核实。',
      modelClient: {
        config: { model: 'fake-model' },
        async complete() {
          return {
            content: JSON.stringify({
              response_level: 'verify',
              policy_matches: [{
                rule_id: 'improper_discipline',
                evidence: '老师当着全班同学的面把他推倒在地',
                missing_facts: ['现场是否有其他人员可以提供旁证'],
              }],
              possible_parent_needs: ['希望孩子的安全和感受被认真对待'],
              reply_strategy: ['先确认孩子情况，再按学校流程核实'],
              questions_to_verify: ['事情发生在什么时间和地点？'],
              draft: '您好，您的留言我收到了，这个情况需要认真处理。我会先确认孩子目前的状态，并立即向学校负责人报告、核实完整经过。在事实查清前我不会仓促下结论，核实后会尽快向您反馈。',
              follow_up: '班主任核实后尽快反馈',
              warnings: [],
            }),
            tool_calls: [],
            reasoning_content: '',
            usage: null,
          };
        },
      },
    });
    expect(result.response_level).toBe('escalate');
    expect(result.compliance_assessment.policy_findings.map(item => item.id)).toContain('improper_discipline');
    expect(result.compliance_assessment.policy_findings[0]?.evidence).toContain('推倒在地');
    expect(result.risk_reasons.join('')).toContain('完整语义');
  });

  it('模型不能把高风险消息降级为普通回复', async () => {
    const result = await generateParentReplyDraft({
      studentId: 1,
      parentMessage: '孩子说在学校被同学霸凌，回家后一直哭，请马上处理。',
      teacherContext: '目前只收到家长单方反馈，尚未核实。',
      feedbackDeadline: '2026-04-16',
      owner: '班主任',
      modelClient: {
        config: { model: 'fake-model' },
        async complete() {
          return {
            content: JSON.stringify({
              response_level: 'direct',
              possible_parent_needs: ['希望孩子安全被认真对待'],
              reply_strategy: ['先确认收到，再按学校流程核实'],
              questions_to_verify: ['发生的时间和地点是什么？'],
              draft: '您好，您反映的情况我已经收到。我会先确认孩子当前状态，并按学校流程核实相关情况，在事实确认前不会下结论。我会在2026-04-16前向您反馈下一步安排。',
              follow_up: '班主任在2026-04-16前反馈',
              warnings: [],
            }),
            tool_calls: [],
            reasoning_content: '',
            usage: null,
          };
        },
      },
    });
    expect(result.response_level).toBe('escalate');
    expect(result.response_label).toBe('建议升级处理');
    expect(result.generation_mode).toBe('ai');
  });

  it('模型不可用时返回规则草稿，不中断页面流程', async () => {
    const result = await generateParentReplyDraft({
      studentId: 1,
      parentMessage: '请问明天返校需要带什么材料？',
      teacherContext: '学校已经发布返校材料清单。',
      modelClient: {
        async complete() {
          throw new Error('模拟模型断开');
        },
      },
    });
    expect(result.generation_mode).toBe('fallback');
    expect(result.draft).toContain('您的留言我收到了');
    expect(result.generation_warning).toContain('AI 暂时不可用');
  });

  it('机械化草稿未通过表达校验时回退为自然安全草稿', async () => {
    const result = await generateParentReplyDraft({
      studentId: 1,
      parentMessage: '孩子连续四天写作业到晚上十一点，是不是作业太多了？',
      teacherContext: '尚未完成各科用时核实。',
      modelClient: {
        async complete() {
          return {
            content: JSON.stringify({
              response_level: 'verify',
              policy_matches: [],
              possible_parent_needs: [],
              reply_strategy: [],
              questions_to_verify: [],
              draft: '老师已经收到。您反映的是：孩子写作业很晚。目前具体反馈时间尚未确定。孩子几点开始？中间休息了吗？每科多久？',
              follow_up: '',
              warnings: [],
            }),
            tool_calls: [],
            reasoning_content: '',
            usage: null,
          };
        },
      },
    });
    expect(result.generation_mode).toBe('fallback');
    expect(result.draft).toContain('您的留言我收到了');
    expect(result.draft).not.toContain('具体反馈时间尚未确定');
    expect((result.draft.match(/[？?]/g) || []).length).toBeLessThanOrEqual(2);
  });

  it('发送给模型的上下文不包含地址和监护人电话', async () => {
    const calls: Array<Array<Record<string, unknown>>> = [];
    await generateParentReplyDraft({
      studentId: 1,
      parentMessage: '想了解孩子最近的学习情况。',
      teacherContext: '准备结合四月月考进行说明。',
      modelClient: {
        async complete(messages: Array<Record<string, unknown>>) {
          calls.push(messages);
          return {
            content: JSON.stringify({
              response_level: 'verify',
              possible_parent_needs: ['希望了解学习进展'],
              reply_strategy: ['基于已确认成绩说明'],
              questions_to_verify: ['家长重点关注哪个学科？'],
              draft: '您好，您的消息我已经收到。我会结合目前已确认的学习记录进行整理，并先核实需要补充的情况，确认后向您反馈具体学习进展和下一步建议。',
              follow_up: '由班主任确认反馈时间',
              warnings: [],
            }),
            tool_calls: [],
            reasoning_content: '',
            usage: null,
          };
        },
      },
    });
    const prompt = JSON.stringify(calls);
    expect(prompt).toContain('四月月考');
    expect(prompt).not.toContain('不应进入模型的家庭地址');
    expect(prompt).not.toContain('13800138000');
  });
});
