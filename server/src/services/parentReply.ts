import type { Database } from 'better-sqlite3';

import { generateStudentSummary, MeetingPrepError, type MeetingPrepSection } from './meetingPrep.js';

export class ParentReplyError extends Error {}

export type ParentReplyLevel = 'direct' | 'verify' | 'escalate';
export type ComplianceState = 'no_signal' | 'possible_conflict' | 'escalate';
export type ComplaintSignalLevel = 'none' | 'emerging' | 'explicit';

export interface ParentReplyPolicyRule {
  id: string;
  category: string;
  title: string;
  basis: string;
  requirement: string;
  response_level: ParentReplyLevel;
}

export interface ParentReplyPolicyFinding extends ParentReplyPolicyRule {
  evidence: string;
  evidence_source: '家长陈述' | '教师补充' | '教师确认';
  evidence_status: '单方陈述' | '待核实' | '已确认';
  missing_facts: string[];
}

export interface ParentReplyComplianceAssessment {
  state: ComplianceState;
  label: string;
  summary: string;
  policy_findings: ParentReplyPolicyFinding[];
  complaint_signal: {
    level: ComplaintSignalLevel;
    label: string;
    summary: string;
    evidence: string[];
  };
  recommended_actions: string[];
  disclaimer: string;
}

export interface ParentReplyFact {
  id: string;
  source: '家长原话' | '教师补充' | '系统记录';
  text: string;
  date?: string;
}

export interface ParentReplyContext {
  student: { id: number; student_no: string; name: string };
  scope: { class_name: string; term_name: string };
  parent_message: string;
  teacher_context: string;
  reply_goal: string;
  teacher_role: string;
  feedback_deadline: string;
  owner: string;
  tone: string;
  response_level: ParentReplyLevel;
  response_label: string;
  known_facts: ParentReplyFact[];
  system_facts: ParentReplyFact[];
  unknowns: string[];
  possible_parent_needs: string[];
  risk_reasons: string[];
  questions_to_verify: string[];
  prohibited_commitments: string[];
  compliance_assessment: ParentReplyComplianceAssessment;
}

export interface ParentReplyOptions {
  studentId: number;
  parentMessage: string;
  teacherContext?: string;
  replyGoal?: string;
  teacherRole?: string;
  feedbackDeadline?: string;
  owner?: string;
  tone?: string;
  conn?: Database;
}

const RED_PATTERNS = [
  /轻生|自杀|自残|不想活|跳楼|割腕/,
  /性侵|猥亵|虐待|暴力|打架|霸凌|欺凌|失踪|走失/,
  /报警|律师|起诉|教育局|媒体|曝光/,
  /处分|开除|收费|收钱|隐私|个人信息.*泄露|照片.*泄露/,
];

const AMBER_PATTERNS = [
  /针对|不公平|区别对待|投诉|体罚|辱骂|惩罚/,
  /作业|熬夜|太多|过量|成绩|分数|排名|批改/,
  /一直哭|不想上学|害怕|焦虑|睡不着/,
  /其他老师|任课老师|同学|班里|为什么/,
];

const DIRECT_PATTERNS = [/几点|什么时候|带什么|怎么交|在哪里|返校|放假|收到|谢谢|是否需要/];

interface InternalPolicyRule extends ParentReplyPolicyRule {
  matches: (text: string) => boolean;
  evidencePattern: RegExp;
  missingFacts: string[];
}

const POLICY_RULES: InternalPolicyRule[] = [
  {
    id: 'homework_sleep',
    category: '学习负担与健康',
    title: '作业统筹与睡眠保障',
    basis: '教育部关于中小学生作业、睡眠管理的相关要求',
    requirement: '学校应统筹作业总量，避免学业负担长期挤占必要睡眠时间；高中作业时间应合理安排。',
    response_level: 'verify',
    matches: text => /(作业|练习|试卷|题目)/.test(text)
      && /(熬夜|睡眠|睡不着|很晚|深夜|凌晨|晚上(?:十|十一|十二|1?\d|2[0-3])点|2[2-3][：:]?\d{0,2})/.test(text),
    evidencePattern: /作业|练习|试卷|题目|熬夜|睡眠|很晚|深夜|凌晨|晚上|2[2-3][：:]?\d{0,2}/,
    missingFacts: ['实际开始与结束时间、各科用时和中途停顿', '是否主要来自学校布置，是否存在班级共性', '学生实际就寝时间和持续天数'],
  },
  {
    id: 'improper_discipline',
    category: '教育惩戒',
    title: '体罚、侮辱或不当惩戒边界',
    basis: '《中小学教育惩戒规则（试行）》',
    requirement: '不得以击打、侮辱、歧视、超限度惩罚等方式侵害学生身心健康和人格尊严。',
    response_level: 'escalate',
    matches: text => /扇(?:了|过)?(?:孩子|学生)?.{0,4}(?:巴掌|耳光)|打(?:了|过)?(?:孩子|学生)|踢(?:了|过)?(?:孩子|学生)|掐(?:了|过)?(?:孩子|学生)|体罚|罚跪|辱骂|侮辱|歧视|长时间罚站|全班.{0,8}(?:罚|惩罚)/.test(text),
    evidencePattern: /巴掌|耳光|打|踢|掐|体罚|罚跪|辱骂|侮辱|歧视|罚站|惩罚/,
    missingFacts: ['发生时间、地点、在场人员和完整经过', '采取措施的具体方式、时长及造成的影响', '学生陈述、教师说明和可核对旁证'],
  },
  {
    id: 'student_safety',
    category: '学生安全',
    title: '欺凌、暴力与人身安全事件',
    basis: '《未成年人学校保护规定》及学校安全处置要求',
    requirement: '涉及欺凌、暴力、性侵害、自伤或失踪等安全信号时，应先确认学生安全并按学校流程及时报告、调查和处置。',
    response_level: 'escalate',
    matches: text => /欺凌|霸凌|围堵|殴打|勒索|性侵|猥亵|虐待|失踪|走失|自残|轻生|自杀|不想活|跳楼|割腕/.test(text),
    evidencePattern: /欺凌|霸凌|围堵|殴打|勒索|性侵|猥亵|虐待|失踪|走失|自残|轻生|自杀|不想活|跳楼|割腕/,
    missingFacts: ['学生当前是否安全、是否需要紧急支持', '发生时间、地点、涉及人员和旁证', '学校是否已经启动报告与保护流程'],
  },
  {
    id: 'student_privacy',
    category: '隐私保护',
    title: '学生及家庭隐私保护',
    basis: '《个人信息保护法》《未成年人学校保护规定》',
    requirement: '学生及家庭信息应按必要、最小范围处理，不得无关公开或向无关人员披露。',
    response_level: 'escalate',
    matches: text => /隐私|个人信息.{0,8}泄露|(?:群里|公开|公布|张贴|发给别人).{0,20}(?:成绩|排名|照片|病历|病情|住址|电话|家庭情况)/.test(text),
    evidencePattern: /隐私|个人信息|泄露|群里|公开|公布|张贴|成绩|排名|照片|病历|病情|住址|电话|家庭情况/,
    missingFacts: ['具体披露的信息、对象、范围和渠道', '是否取得必要授权，是否已经停止传播', '是否需要删除、澄清或启动隐私事件处置'],
  },
  {
    id: 'major_discipline',
    category: '纪律处分',
    title: '较重惩戒与纪律处分程序',
    basis: '《中小学教育惩戒规则（试行）》',
    requirement: '停课、停学、处分或开除等事项应由学校依规定权限和程序处理，教师个人不得先行承诺结果。',
    response_level: 'escalate',
    matches: text => /停课|停学|处分|开除|记过|留校察看/.test(text),
    evidencePattern: /停课|停学|处分|开除|记过|留校察看/,
    missingFacts: ['拟采取措施的依据、决定主体和程序状态', '学生及家长是否已经获得陈述、申辩或告知机会'],
  },
  {
    id: 'fees',
    category: '收费管理',
    title: '收费与费用公开',
    basis: '学校现行收费管理制度及当地教育主管部门规定',
    requirement: '涉及强制收费、未公示收费或退款争议时，应核对项目依据和经办流程，不由教师个人承诺责任或结果。',
    response_level: 'escalate',
    matches: text => /(收费|班费|资料费|补课费|收钱)/.test(text) && /(强制|必须交|乱收|没公示|未公示|不退|违规|投诉)/.test(text),
    evidencePattern: /收费|班费|资料费|补课费|收钱|强制|必须交|乱收|公示|不退|违规/,
    missingFacts: ['收费项目、金额、依据、通知和经办主体', '是否完成公示、授权、票据或退款流程'],
  },
];

const EXPLICIT_COMPLAINT_PATTERN = /报警|律师|起诉|教育局|教体局|12345|信访|媒体|曝光|举报到|投诉到/;
const EMERGING_COMPLAINT_PATTERN = /投诉|举报|追责|给个说法|正式说明|书面说明|保留证据/;

function clip(value: unknown, limit: number): string {
  const text = String(value ?? '').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

function levelRank(level: ParentReplyLevel): number {
  return { direct: 0, verify: 1, escalate: 2 }[level];
}

function sentenceContaining(text: string, pattern: RegExp): string {
  const sentences = text.split(/(?<=[。！？!?；;\n])/).map(item => item.trim()).filter(Boolean);
  return clip(sentences.find(item => pattern.test(item)) || text, 180);
}

function complaintSignal(message: string): ParentReplyComplianceAssessment['complaint_signal'] {
  const explicit = message.match(EXPLICIT_COMPLAINT_PATTERN);
  if (explicit) {
    return {
      level: 'explicit',
      label: '已出现明确升级表达',
      summary: '家长原话已经出现向校外机构、司法渠道或公开渠道升级的表达，应保留原始信息并按学校流程报告。',
      evidence: [sentenceContaining(message, EXPLICIT_COMPLAINT_PATTERN)],
    };
  }
  const emerging = message.match(EMERGING_COMPLAINT_PATTERN);
  if (emerging) {
    return {
      level: 'emerging',
      label: '出现投诉升级信号',
      summary: '家长正在要求追责、正式说明或表达投诉意向，回复前应核实事实并明确校内处理路径。',
      evidence: [sentenceContaining(message, EMERGING_COMPLAINT_PATTERN)],
    };
  }
  return {
    level: 'none',
    label: '暂未出现明确升级表达',
    summary: '当前未识别到投诉、诉讼或公开曝光等明确表达；这不代表事项本身没有合规风险。',
    evidence: [],
  };
}

function policyRule(ruleId: string): InternalPolicyRule | undefined {
  return POLICY_RULES.find(rule => rule.id === ruleId);
}

function teacherTextIsConfirmed(text: string): boolean {
  return !/尚未|未核实|没有核实|不确定|待核实|听说|据说|家长(?:说|反映)|学生(?:说|反映)/.test(text);
}

function deterministicPolicyFindings(parentMessage: string, teacherContext: string): ParentReplyPolicyFinding[] {
  const findings: ParentReplyPolicyFinding[] = [];
  for (const rule of POLICY_RULES) {
    const teacherMentioned = Boolean(teacherContext && rule.matches(teacherContext));
    const teacherConfirmed = teacherMentioned && teacherTextIsConfirmed(teacherContext);
    const parentReported = rule.matches(parentMessage);
    if (!teacherMentioned && !parentReported) continue;
    const sourceText = teacherConfirmed || (!parentReported && teacherMentioned) ? teacherContext : parentMessage;
    const source = teacherConfirmed ? '教师确认' : parentReported ? '家长陈述' : '教师补充';
    const status = teacherConfirmed ? '已确认' : parentReported ? '单方陈述' : '待核实';
    findings.push({
      id: rule.id,
      category: rule.category,
      title: rule.title,
      basis: rule.basis,
      requirement: rule.requirement,
      response_level: rule.response_level,
      evidence: sentenceContaining(sourceText, rule.evidencePattern),
      evidence_source: source,
      evidence_status: status,
      missing_facts: teacherConfirmed ? [] : rule.missingFacts,
    });
  }
  return findings;
}

export function parentReplyPolicyCatalog(): ParentReplyPolicyRule[] {
  return POLICY_RULES.map(({ matches: _matches, evidencePattern: _evidencePattern, missingFacts: _missingFacts, ...rule }) => rule);
}

export function createComplianceAssessment(
  parentMessage: string,
  teacherContext: string,
  findings = deterministicPolicyFindings(parentMessage, teacherContext),
): ParentReplyComplianceAssessment {
  const complaint = complaintSignal(parentMessage);
  const strongest = findings.reduce<ParentReplyLevel>(
    (level, finding) => levelRank(finding.response_level) > levelRank(level) ? finding.response_level : level,
    'direct',
  );
  const state: ComplianceState = strongest === 'escalate'
    ? 'escalate'
    : findings.length ? 'possible_conflict' : 'no_signal';
  const labels: Record<ComplianceState, string> = {
    no_signal: '暂未发现明确制度冲突',
    possible_conflict: '可能涉及制度边界，需核实',
    escalate: '涉及重要制度边界，建议升级处理',
  };
  const summaries: Record<ComplianceState, string> = {
    no_signal: '根据当前文字未匹配到明确制度边界；仍应以完整事实和学校现行制度为准。',
    possible_conflict: '如果家长描述属实，事项可能与下列要求有关；当前证据不足以认定违规。',
    escalate: '事项涉及安全、惩戒、处分、隐私或收费等重要边界，应先保护学生、保留记录并按学校流程处理。',
  };
  const actions: string[] = [];
  if (findings.length) actions.push('逐项核实触发事实，并区分家长陈述、教师确认和系统记录');
  if (findings.some(item => item.response_level === 'escalate')) {
    actions.push('在普通回复前报告年级或学校负责人，必要时联系法治副校长或相应专业人员');
  } else if (findings.length) {
    actions.push('核对班级共性、个体差异和学校现行制度，再确定是否需要年级统筹');
  }
  if (complaint.level !== 'none') actions.push('保留家长原话、核实过程、最终回复和后续约定，避免口头承诺无记录');
  actions.push('回复只确认收悉、下一步和反馈时间，不在事实未明时承认违规或归责');

  return {
    state,
    label: labels[state],
    summary: summaries[state],
    policy_findings: findings,
    complaint_signal: complaint,
    recommended_actions: unique(actions),
    disclaimer: '辅助判断，不构成法律结论；最终以完整事实、学校制度和有权部门意见为准。',
  };
}

export function mergeSemanticPolicyFindings(
  context: Pick<ParentReplyContext, 'parent_message' | 'teacher_context' | 'compliance_assessment'>,
  candidates: unknown,
): ParentReplyPolicyFinding[] {
  const merged = new Map(context.compliance_assessment.policy_findings.map(item => [item.id, item]));
  if (!Array.isArray(candidates)) return [...merged.values()];
  for (const value of candidates) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const rule = policyRule(String(candidate.rule_id ?? ''));
    const evidence = clip(candidate.evidence, 180);
    if (!rule || !evidence) continue;
    const inTeacherContext = context.teacher_context.includes(evidence);
    const inParentMessage = context.parent_message.includes(evidence);
    if (!inTeacherContext && !inParentMessage) continue;
    const modelMissing = Array.isArray(candidate.missing_facts)
      ? candidate.missing_facts.map(item => clip(item, 160)).filter(Boolean).slice(0, 4)
      : [];
    const existing = merged.get(rule.id);
    const teacherConfirmed = inTeacherContext && teacherTextIsConfirmed(context.teacher_context);
    merged.set(rule.id, {
      id: rule.id,
      category: rule.category,
      title: rule.title,
      basis: rule.basis,
      requirement: rule.requirement,
      response_level: rule.response_level,
      evidence: existing?.evidence || evidence,
      evidence_source: existing?.evidence_source || (teacherConfirmed ? '教师确认' : inTeacherContext ? '教师补充' : '家长陈述'),
      evidence_status: existing?.evidence_status || (teacherConfirmed ? '已确认' : inTeacherContext ? '待核实' : '单方陈述'),
      missing_facts: unique([...(existing?.missing_facts || []), ...modelMissing, ...rule.missingFacts]).slice(0, 5),
    });
  }
  return [...merged.values()];
}

function itemDate(item: Record<string, unknown>): string {
  return clip(item.exam_date || item.date || item.occurred_at || item.communicated_at, 20);
}

function itemText(section: MeetingPrepSection, item: Record<string, unknown>): string {
  if (item.summary) return clip(item.summary, 220);
  if (section.source === 'exam_records') {
    return [item.exam_name, item.subject, item.score == null ? '' : `${item.score}分`, item.rank ? `第${item.rank}名` : '']
      .map(value => clip(value, 80)).filter(Boolean).join(' · ');
  }
  if (section.source === 'attendance_records') {
    return [item.scene, item.status, item.reason].map(value => clip(value, 120)).filter(Boolean).join(' · ');
  }
  if (section.source === 'point_ledger') {
    return [item.reason, item.amount == null ? '' : `${Number(item.amount) > 0 ? '+' : ''}${item.amount}分`, item.category]
      .map(value => clip(value, 120)).filter(Boolean).join(' · ');
  }
  if (section.source === 'communications') {
    return [item.method, item.reason, item.status, item.followup_at ? `后续：${item.followup_at}` : '']
      .map(value => clip(value, 120)).filter(Boolean).join(' · ');
  }
  return [item.event_type, item.description, item.status]
    .map(value => clip(value, 160)).filter(Boolean).join(' · ');
}

function systemFacts(sections: MeetingPrepSection[]): ParentReplyFact[] {
  const facts: ParentReplyFact[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      const text = itemText(section, item);
      if (!text) continue;
      facts.push({
        id: `S${facts.length + 1}`,
        source: '系统记录',
        text: `${section.source_label}：${text}`,
        date: itemDate(item),
      });
      if (facts.length >= 30) return facts;
    }
  }
  return facts;
}

function classify(
  message: string,
  teacherContext: string,
  assessment: ParentReplyComplianceAssessment,
): ParentReplyLevel {
  if (assessment.state === 'escalate' || assessment.complaint_signal.level === 'explicit') return 'escalate';
  if (assessment.state === 'possible_conflict' || assessment.complaint_signal.level === 'emerging') return 'verify';
  if (RED_PATTERNS.some(pattern => pattern.test(message))) return 'escalate';
  if (!teacherContext || AMBER_PATTERNS.some(pattern => pattern.test(message))) return 'verify';
  if (DIRECT_PATTERNS.some(pattern => pattern.test(message))) return 'direct';
  return 'verify';
}

function possibleNeeds(message: string): string[] {
  const needs: string[] = [];
  if (/不回复|没回复|为什么.*回复|一直.*回复/.test(message)) {
    needs.push('可能希望确认消息已经被看到，并知道下一次反馈时间');
  }
  if (/针对|不公平|区别对待|别人|其他同学/.test(message)) {
    needs.push('可能希望确认处理标准是否公平，孩子是否被尊重');
  }
  if (/班里|发生|经过|到底|为什么/.test(message)) {
    needs.push('可能希望了解已经核实的经过和当前处理进度');
  }
  if (/作业|批改|成绩|分数|排名/.test(message)) {
    needs.push('可能希望了解学习安排、完成过程或反馈进度');
  }
  if (/哭|害怕|不想上学|欺凌|霸凌|打架|自残|轻生/.test(message)) {
    needs.push('可能希望孩子的安全和感受被认真对待');
  }
  if (needs.length === 0) needs.push('可能希望获得明确、尊重并且可执行的回应');
  return needs;
}

function unknownsFor(message: string, level: ParentReplyLevel, owner: string, deadline: string): string[] {
  const unknowns: string[] = [];
  if (level !== 'direct') unknowns.push('家长原话中的具体经过尚未完成校内核实');
  if (/作业|熬夜|太多|过量/.test(message)) {
    unknowns.push('尚未核实各科实际用时、中途停顿、具体卡点和班级共性');
  }
  if (/成绩|分数|排名|批改/.test(message)) {
    unknowns.push('尚未核实对应考试或作业范围、批改录入状态和评价口径');
  }
  if (/针对|不公平|同学|欺凌|霸凌|打架|哭|害怕/.test(message)) {
    unknowns.push('尚未核实发生时间、地点、涉及人员和可核对的旁证');
  }
  if (!owner) unknowns.push('尚未明确由谁负责核实和反馈');
  if (!deadline) unknowns.push('尚未约定下一次反馈时间');
  return unique(unknowns);
}

function questionsFor(message: string, owner: string, deadline: string): string[] {
  const questions = ['家长描述中的时间、地点、人物和经过，哪些已经核实？'];
  if (/作业|熬夜|太多|过量/.test(message)) {
    questions.push('孩子每天几点开始、几点结束，中间是否停顿，各科分别用了多久？');
    questions.push('困难集中在哪些题目或任务，是个别情况还是班级共性？');
  }
  if (/成绩|分数|排名|批改/.test(message)) {
    questions.push('对应哪一次考试或作业，当前批改和录入是否已经完成？');
  }
  if (/针对|不公平|同学|欺凌|霸凌|打架|哭|害怕/.test(message)) {
    questions.push('是否需要分别向学生、相关教师或现场人员核实，避免让当事人相互影响陈述？');
  }
  if (!owner) questions.push('本次由谁负责核实并对家长反馈？');
  if (!deadline) questions.push('下一次最晚在什么时间向家长反馈？');
  return unique(questions).slice(0, 8);
}

export function prepareParentReplyContext(options: ParentReplyOptions): ParentReplyContext {
  const parentMessage = clip(options.parentMessage, 3000);
  const teacherContext = clip(options.teacherContext, 1200);
  if (!Number.isInteger(Number(options.studentId)) || Number(options.studentId) < 1) {
    throw new ParentReplyError('请选择对应学生');
  }
  if (parentMessage.length < 4) throw new ParentReplyError('请粘贴完整的家长消息');

  const teacherRole = clip(options.teacherRole, 20) || '班主任';
  if (!['班主任', '任课教师'].includes(teacherRole)) throw new ParentReplyError('教师角色不合法');
  const replyGoal = clip(options.replyGoal, 120) || '回应关切并明确下一步';
  const feedbackDeadline = clip(options.feedbackDeadline, 40);
  const owner = clip(options.owner, 40);
  const tone = clip(options.tone, 20) || '自然';
  if (!['自然', '简洁', '更有同理心', '边界更清晰'].includes(tone)) {
    throw new ParentReplyError('回复语气不合法');
  }

  let summary;
  try {
    summary = generateStudentSummary({ studentId: Number(options.studentId), conn: options.conn });
  } catch (error) {
    if (error instanceof MeetingPrepError) throw new ParentReplyError(error.message);
    throw error;
  }
  const complianceAssessment = createComplianceAssessment(parentMessage, teacherContext);
  const level = classify(parentMessage, teacherContext, complianceAssessment);
  const levelLabels: Record<ParentReplyLevel, string> = {
    direct: '可直接回复',
    verify: '核实后回复',
    escalate: '建议升级处理',
  };
  const riskReasons: string[] = [];
  if (complianceAssessment.policy_findings.length) {
    riskReasons.push(`已匹配${complianceAssessment.policy_findings.length}项可能涉及的制度边界，需结合完整事实核实`);
  }
  if (complianceAssessment.complaint_signal.level === 'explicit') {
    riskReasons.push('家长原话中已出现明确投诉或校外升级表达');
  }
  if (level === 'escalate') riskReasons.push('当前事项不适合由教师个人直接作出责任或处理结论');
  if (level === 'verify') riskReasons.push('消息中的关键事实尚不完整，直接下结论可能造成误解或越权承诺');
  if (!teacherContext) riskReasons.push('教师尚未补充已掌握的校内情况');

  const knownFacts: ParentReplyFact[] = [
    { id: 'P1', source: '家长原话', text: parentMessage },
  ];
  if (teacherContext) knownFacts.push({ id: 'T1', source: '教师补充', text: teacherContext });

  const prohibited = [
    '未核实前不得承认学校、教师或学生存在过错',
    '不得替其他教师、学校管理人员或其他家长作出承诺',
    '不得透露其他学生、家长或无关人员的隐私信息',
    '不得把对家长诉求的推测写成事实或写入学生档案',
  ];
  if (level === 'escalate') prohibited.push('不得仅凭一条消息作出法律、心理或医学结论');

  return {
    student: {
      id: Number(summary.student.id),
      student_no: clip(summary.student['学号'], 40),
      name: clip(summary.student['姓名'], 80),
    },
    scope: summary.scope,
    parent_message: parentMessage,
    teacher_context: teacherContext,
    reply_goal: replyGoal,
    teacher_role: teacherRole,
    feedback_deadline: feedbackDeadline,
    owner,
    tone,
    response_level: level,
    response_label: levelLabels[level],
    known_facts: knownFacts,
    system_facts: systemFacts(summary.sections),
    unknowns: unknownsFor(parentMessage, level, owner, feedbackDeadline),
    possible_parent_needs: possibleNeeds(parentMessage),
    risk_reasons: unique(riskReasons),
    questions_to_verify: questionsFor(parentMessage, owner, feedbackDeadline),
    prohibited_commitments: prohibited,
    compliance_assessment: complianceAssessment,
  };
}
