import type { ExcelImportPlan, FieldMapping, TableRegion, WorkbookArtifact } from '../domain/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDb } from '../../services/context.js';
import {
  executeImport, executeImportBuffer, generateImportPreview, prepareImportBuffer, previewImportBuffer,
} from '../../services/excelImportAssistant.js';
import type { PreparedImportBuffer } from '../../services/excelImportAssistant.js';

export interface ImportFieldDefinition {
  target: string;
  label: string;
  required?: boolean;
}

export interface DetectionResult {
  confidence: number;
  reason: string;
}

export interface ImportAdapterContext {
  artifact: WorkbookArtifact;
  plan: ExcelImportPlan;
  mappings: FieldMapping[];
  options: Record<string, unknown>;
  /** Temporary compatibility bridge until the old upload service is migrated to Artifact IDs. */
  legacyFileId?: string;
}

export interface ImportVerificationResult {
  verified: boolean;
  evidence: string;
}

export interface ExcelImportAdapter {
  readonly id: string;
  readonly label: string;
  readonly version: string;
  fields(): ImportFieldDefinition[];
  duplicateStrategies(): string[];
  detect(region: TableRegion): DetectionResult;
  preview(context: ImportAdapterContext): Promise<Record<string, unknown>>;
  execute(context: ImportAdapterContext & { requestId: string }): Promise<Record<string, unknown>>;
  verify(context: ImportAdapterContext & { requestId?: string }, result: Record<string, unknown>): Promise<ImportVerificationResult>;
  prepare?(context: ImportAdapterContext): Promise<PreparedImportBuffer>;
  commitPrepared?(context: ImportAdapterContext & { requestId: string }, prepared: PreparedImportBuffer): Record<string, unknown>;
  verifySync?(context: ImportAdapterContext & { requestId?: string }, result: Record<string, unknown>): ImportVerificationResult;
}

class LegacyImportAdapter implements ExcelImportAdapter {
  constructor(
    public readonly id: string,
    public readonly label: string,
    private readonly definitions: ImportFieldDefinition[],
    private readonly hints: string[],
    private readonly strategies: string[],
  ) {}

  readonly version = '1';

  fields(): ImportFieldDefinition[] {
    return this.definitions.map(item => ({ ...item }));
  }

  duplicateStrategies(): string[] {
    return [...this.strategies];
  }

  detect(region: TableRegion): DetectionResult {
    const normalized = new Set(region.headers.map(header => header.replace(/\s+/g, '').trim()));
    const hits = this.hints.filter(hint => normalized.has(hint)).length;
    const confidence = Math.min(0.95, hits / Math.max(this.hints.length, 1) + (hits > 0 ? 0.2 : 0));
    return {
      confidence,
      reason: hits > 0 ? `匹配 ${hits} 个${this.label}字段` : `未匹配到${this.label}字段`,
    };
  }

  private legacyFileId(context: ImportAdapterContext): string {
    if (!context.legacyFileId) {
      throw new Error(`Adapter ${this.id} 尚未接入 WorkbookArtifact 执行器`);
    }
    return context.legacyFileId;
  }

  private region(context: ImportAdapterContext): TableRegion {
    const sheet = context.artifact.blueprint?.sheets[context.plan.sheetIndex];
    const region = sheet?.regions.find(item => item.id === context.plan.regionId) ?? sheet?.regions[0];
    if (!region) throw new Error(`Adapter ${this.id} 找不到导入区域`);
    return region;
  }

  private async artifactBuffer(context: ImportAdapterContext): Promise<Buffer> {
    const root = path.resolve(getDb().paths.dataDir);
    const filePath = path.resolve(root, context.artifact.storagePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error('Excel Artifact 存储路径无效');
    }
    const buffer = await fs.readFile(filePath);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (sha256 !== context.artifact.sha256) throw new Error('Excel Artifact 文件内容已变化，请重新上传');
    return buffer;
  }

  async preview(context: ImportAdapterContext): Promise<Record<string, unknown>> {
    if (context.legacyFileId) {
      const result = await generateImportPreview({
        fileId: this.legacyFileId(context), module: this.id, sheetIndex: context.plan.sheetIndex,
        duplicateStrategy: String(context.options.duplicateStrategy ?? 'update'),
        owner: context.artifact.ownerId, session: context.artifact.sessionId, channel: context.artifact.channel,
      });
      return result as unknown as Record<string, unknown>;
    }
    const region = this.region(context);
    return previewImportBuffer({
      buffer: await this.artifactBuffer(context), filename: context.artifact.filename, module: this.id,
      sheetIndex: context.plan.sheetIndex, headerRow: region.headerRows[0] ?? 1,
      mappings: context.mappings.map(mapping => ({
        sourceColumn: mapping.sourceColumn, targetField: mapping.targetField,
        source: mapping.source === 'rule' ? 'rule' : mapping.source === 'ai' ? 'ai' : 'manual',
        confidence: mapping.confidence, status: mapping.status, confirmedByUser: mapping.confirmedByUser,
      })), duplicateStrategy: String(context.options.duplicateStrategy ?? 'update'),
    });
  }

  async execute(context: ImportAdapterContext & { requestId: string }): Promise<Record<string, unknown>> {
    if (context.legacyFileId) {
      const result = await executeImport({
        fileId: this.legacyFileId(context), module: this.id, previewHash: context.plan.previewHash,
        requestId: context.requestId, owner: context.artifact.ownerId,
        session: context.artifact.sessionId, channel: context.artifact.channel,
      });
      return result as unknown as Record<string, unknown>;
    }
    const region = this.region(context);
    return executeImportBuffer({
      buffer: await this.artifactBuffer(context), filename: context.artifact.filename, module: this.id,
      sheetIndex: context.plan.sheetIndex, headerRow: region.headerRows[0] ?? 1,
      mappings: context.mappings.map(mapping => ({
        sourceColumn: mapping.sourceColumn, targetField: mapping.targetField,
        source: mapping.source === 'rule' ? 'rule' : mapping.source === 'ai' ? 'ai' : 'manual',
        confidence: mapping.confidence, status: mapping.status, confirmedByUser: mapping.confirmedByUser,
      })), duplicateStrategy: String(context.options.duplicateStrategy ?? 'update'),
      requestId: context.requestId,
    });
  }

  async prepare(context: ImportAdapterContext): Promise<PreparedImportBuffer> {
    if (context.legacyFileId) throw new Error(`Adapter ${this.id} 的旧版上传链不支持事务准备`);
    const region = this.region(context);
    return prepareImportBuffer({
      buffer: await this.artifactBuffer(context), filename: context.artifact.filename, module: this.id,
      sheetIndex: context.plan.sheetIndex, headerRow: region.headerRows[0] ?? 1,
      mappings: context.mappings.map(mapping => ({
        sourceColumn: mapping.sourceColumn, targetField: mapping.targetField,
        source: mapping.source === 'rule' ? 'rule' : mapping.source === 'ai' ? 'ai' : 'manual',
        confidence: mapping.confidence, status: mapping.status,
      })), duplicateStrategy: String(context.options.duplicateStrategy ?? 'update'),
    });
  }

  commitPrepared(
    context: ImportAdapterContext & { requestId: string }, prepared: PreparedImportBuffer,
  ): Record<string, unknown> {
    return { ...prepared.commit(context.requestId), field_mapping: prepared.fieldMapping };
  }

  verifySync(context: ImportAdapterContext & { requestId?: string }, result: Record<string, unknown>): ImportVerificationResult {
    const counters = ['imported', 'updated', 'skipped', 'error_count'];
    const hasResultShape = counters.every((key) => (
      typeof result[key] === 'number' && Number.isFinite(Number(result[key])) && Number(result[key]) >= 0
    ));
    if (!hasResultShape) return { verified: false, evidence: `${this.id}:result-counters-invalid` };

    const classId = context.artifact.classId;
    const termId = context.artifact.termId;
    let run: Record<string, unknown> | undefined;
    if (this.id === 'students') {
      run = getDb().connInstance.prepare(
        'SELECT imported, updated, skipped, error_count FROM student_import_runs '
        + 'WHERE filename=? ORDER BY id DESC LIMIT 1',
      ).get(context.artifact.filename) as Record<string, unknown> | undefined;
    } else if (this.id === 'scores') {
      run = getDb().connInstance.prepare(
        'SELECT imported, updated, skipped, error_count FROM score_import_runs '
        + 'WHERE id=? AND class_id=? AND term_id=?',
      ).get(Number(result.run_id ?? 0), classId, termId) as Record<string, unknown> | undefined;
    } else if (this.id === 'calendar') {
      run = getDb().connInstance.prepare(
        'SELECT imported, updated, skipped, error_count FROM school_calendar_import_runs '
        + 'WHERE request_id=? AND class_id=? AND term_id=?',
      ).get(String(context.requestId ?? ''), classId, termId) as Record<string, unknown> | undefined;
    } else if (this.id === 'timetable') {
      run = getDb().connInstance.prepare(
        'SELECT imported_entries AS imported, updated_entries AS updated, skipped, error_count '
        + 'FROM timetable_import_runs WHERE request_id=? AND class_id=? AND term_id=?',
      ).get(String(context.requestId ?? ''), classId, termId) as Record<string, unknown> | undefined;
    }
    if (!run) return { verified: false, evidence: `${this.id}:import-run-not-found` };
    const matches = counters.every((key) => Number(run![key]) === Number(result[key]));
    return {
      verified: matches,
      evidence: `${this.id}:import-run=${matches ? 'matched' : 'mismatch'}`,
    };
  }

  async verify(context: ImportAdapterContext & { requestId?: string }, result: Record<string, unknown>): Promise<ImportVerificationResult> {
    return this.verifySync(context, result);
  }
}

const adapters: ExcelImportAdapter[] = [
  new LegacyImportAdapter('students', '学生信息', [
    { target: '学号', label: '学号', required: true },
    { target: '姓名', label: '姓名', required: true },
    { target: '性别', label: '性别' },
    { target: '监护人姓名', label: '监护人姓名' },
    { target: '监护人电话', label: '监护人电话' },
  ], ['学号', '姓名', '性别'], ['update', 'skip']),
  new LegacyImportAdapter('scores', '成绩', [
    { target: '学号', label: '学号', required: true },
    { target: '姓名', label: '姓名' },
    { target: '考试名称', label: '考试名称', required: true },
    { target: '科目', label: '科目', required: true },
    { target: '分数', label: '分数' },
    { target: '排名', label: '排名' },
  ], ['学号', '考试名称', '科目', '分数'], ['update', 'skip']),
  new LegacyImportAdapter('calendar', '校历', [
    { target: 'date', label: '日期' },
    { target: 'day_type', label: '类型' },
    { target: 'title', label: '事项' },
    { target: 'is_school_day', label: '是否上课' },
  ], ['日期', '日历日期', '校历日期', '月份'], ['merge', 'skip', 'conflict']),
  new LegacyImportAdapter('timetable', '课程表', [
    { target: 'weekday', label: '星期', required: true },
    { target: 'period_no', label: '节次', required: true },
    { target: 'subject', label: '科目', required: true },
    { target: 'teacher_name', label: '任课教师' },
    { target: 'room', label: '教室' },
  ], ['星期', '周几', '星期几', '节次', '第几节', '科目'], ['replace', 'merge']),
];

const adapterById = new Map(adapters.map(adapter => [adapter.id, adapter]));

export function listImportAdapters(): ExcelImportAdapter[] {
  return adapters.slice();
}

export function getImportAdapter(id: string): ExcelImportAdapter {
  const adapter = adapterById.get(id);
  if (!adapter) throw new Error(`不支持的 Excel 导入类型：${id}`);
  return adapter;
}
