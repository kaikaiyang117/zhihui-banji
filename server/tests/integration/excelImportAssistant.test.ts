import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

import { WorkbenchDb } from '../../src/db/connection.js';
import {
  bindRequestScope, createClass, resetRequestScope, setDatabase,
} from '../../src/services/context.js';
import {
  analyzeUpload, buildErrorExcel, discardUpload, executeImport, generateImportPreview,
} from '../../src/services/excelImportAssistant.js';
import { analyzeExcelSemantics } from '../../src/agent/excelSemanticAnalyzer.js';

let tempDir: string;
let db: WorkbenchDb;
let previousDataDir: string | undefined;

async function workbookBuffer(options: {
  headers: string[];
  rows: unknown[][];
  title?: string;
  withLeadingSheet?: boolean;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  if (options.withLeadingSheet) {
    const notes = workbook.addWorksheet('说明');
    notes.getCell('A1').value = '请阅读说明';
  }
  const sheet = workbook.addWorksheet('数据页');
  let row = 1;
  if (options.title) sheet.getRow(row++).values = [options.title];
  sheet.getRow(row++).values = options.headers;
  options.rows.forEach(values => { sheet.getRow(row++).values = values; });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-assistant-'));
  previousDataDir = process.env.WORKBENCH_DATA_DIR;
  process.env.WORKBENCH_DATA_DIR = tempDir;
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  resetRequestScope();
});

afterEach(() => {
  resetRequestScope();
  db.close();
  setDatabase(null);
  if (previousDataDir === undefined) delete process.env.WORKBENCH_DATA_DIR;
  else process.env.WORKBENCH_DATA_DIR = previousDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Excel 混合识别与安全执行', () => {
  it('拒绝伪装成 xlsx 的损坏文件', async () => {
    await expect(analyzeUpload({
      buffer: Buffer.from('not-an-xlsx'), originalName: '损坏.xlsx', sessionId: 'test-session',
    })).rejects.toThrow(/不是有效的 \.xlsx/);
  });

  it('AI 只接收结构轮廓，并可补充陌生列名及指定工作表', async () => {
    const buffer = await workbookBuffer({
      withLeadingSheet: true,
      title: '学生基础资料',
      headers: ['编号代码', '学生全名'],
      rows: [['AI001', '测试甲']],
    });
    const analysis = await analyzeUpload({
      buffer,
      originalName: '待导入.xlsx',
      sessionId: 'test-session',
      semanticAnalyzer: async input => {
        expect(JSON.stringify(input)).not.toContain('AI001');
        expect(JSON.stringify(input)).not.toContain('测试甲');
        expect(input.sheets[1].header_row).toBe(2);
        return {
          candidates: [{ module: 'students', sheet_index: 1, confidence: 0.91, reason: '列名表示学生身份信息' }],
          mappings: [
            { module: 'students', sheet_index: 1, source: '编号代码', target: '学号', confidence: 0.9, reason: '编号语义' },
            { module: 'students', sheet_index: 1, source: '学生全名', target: '姓名', confidence: 0.9, reason: '姓名语义' },
            { module: 'students', sheet_index: 1, source: '学生全名', target: '未授权字段', confidence: 1, reason: '越权映射' },
          ],
          model: 'test-model',
          warning: '',
        };
      },
    });

    expect(analysis.recognition_mode).toBe('hybrid');
    expect(analysis.candidate_modules[0]).toMatchObject({ module: 'students', sheet_index: 1, source: 'ai' });
    const preview = await generateImportPreview({
      fileId: analysis.file_id, module: 'students', sheetIndex: 1, session: 'test-session',
    });
    expect(preview.valid_rows).toBe(1);
    expect(preview.field_mapping.map(item => [item.target, item.source_kind])).toEqual([
      ['学号', 'ai'], ['姓名', 'ai'],
    ]);

    const first = await executeImport({
      fileId: analysis.file_id, module: 'students', previewHash: preview.preview_hash,
      requestId: 'request-1', session: 'test-session',
    });
    expect(first.imported).toBe(1);
    const retry = await executeImport({
      fileId: analysis.file_id, module: 'students', previewHash: preview.preview_hash,
      requestId: 'request-1', session: 'test-session',
    });
    expect(retry).toEqual(first);
    expect(db.connInstance.prepare('SELECT 姓名 FROM students WHERE 学号=?').get('AI001')).toMatchObject({ 姓名: '测试甲' });
    discardUpload(analysis.file_id, { session: 'test-session' });
  });

  it('模型不可用时回退到本地规则，且不会阻塞预览', async () => {
    const buffer = await workbookBuffer({ headers: ['学号', '姓名'], rows: [['R001', '规则同学']] });
    const analysis = await analyzeUpload({
      buffer, originalName: '学生.xlsx', sessionId: 'rules',
      semanticAnalyzer: async () => ({
        candidates: [], mappings: [], model: '', warning: 'AI 语义识别暂时不可用，本次使用本地规则识别',
      }),
    });
    expect(analysis.recognition_mode).toBe('rules');
    expect(analysis.recognition_warning).toContain('本地规则');
    const preview = await generateImportPreview({
      fileId: analysis.file_id, module: 'students', session: 'rules',
    });
    expect(preview.valid_rows).toBe(1);
    discardUpload(analysis.file_id, { session: 'rules' });
  });

  it('多个来源列指向同一目标字段时拒绝生成含糊预览', async () => {
    const buffer = await workbookBuffer({
      headers: ['学号', '学生编号', '姓名'], rows: [['A001', 'B001', '冲突同学']],
    });
    const analysis = await analyzeUpload({ buffer, originalName: '冲突.xlsx', sessionId: 'conflict' });
    await expect(generateImportPreview({
      fileId: analysis.file_id, module: 'students', session: 'conflict',
    })).rejects.toThrow(/字段映射存在冲突/);
    discardUpload(analysis.file_id, { session: 'conflict' });
  });

  it('上传后切换班级或学期会使预览失效', async () => {
    const buffer = await workbookBuffer({ headers: ['学号', '姓名'], rows: [['SCOPE01', '范围同学']] });
    const analysis = await analyzeUpload({ buffer, originalName: '范围.xlsx', sessionId: 'scope' });
    const other = createClass('测试二班', '高一', '2026 秋季');
    bindRequestScope(Number(other.class_id), Number(other.term_id));
    await expect(generateImportPreview({
      fileId: analysis.file_id, module: 'students', session: 'scope',
    })).rejects.toThrow(/当前班级或学期已切换/);
    resetRequestScope();
    discardUpload(analysis.file_id, { session: 'scope' });
  });

  it('执行后仍可下载错误报告', async () => {
    const buffer = await workbookBuffer({ headers: ['学号', '姓名'], rows: [['ERR01', '']] });
    const analysis = await analyzeUpload({ buffer, originalName: '错误.xlsx', sessionId: 'errors' });
    const preview = await generateImportPreview({
      fileId: analysis.file_id, module: 'students', session: 'errors',
    });
    expect(preview.error_rows).toBe(1);
    const result = await executeImport({
      fileId: analysis.file_id, module: 'students', previewHash: preview.preview_hash,
      requestId: 'error-request', session: 'errors',
    });
    expect(result.error_count).toBe(1);
    const errorWorkbook = new ExcelJS.Workbook();
    await errorWorkbook.xlsx.load(await buildErrorExcel(
      analysis.file_id, 'students', { session: 'errors' },
    ));
    expect(errorWorkbook.worksheets[0].getCell('B2').text).toContain('缺少姓名');
    discardUpload(analysis.file_id, { session: 'errors' });
  });
});

describe('Excel AI 语义分析器', () => {
  const input = {
    filename: '上传文件.xlsx',
    supported_modules: ['students', 'scores', 'calendar', 'timetable'],
    allowed_targets: { students: [{ target: '学号', label: '学号' }] },
    sheets: [{
      sheet_index: 0, name: '数据页', header_row: 1, headers: ['编号'], row_count: 1,
      sample_types: [['numeric-text']],
    }],
  };

  it('解析严格 JSON 结果供服务层继续做白名单校验', async () => {
    const result = await analyzeExcelSemantics(input, {
      config: { model: 'semantic-test' },
      complete: async () => ({
        content: '```json\n{"candidates":[{"module":"students","sheet_index":0,"confidence":0.8,"reason":"编号列"}],"mappings":[]}\n```',
        tool_calls: [], reasoning_content: '', usage: null,
      }),
    });
    expect(result.model).toBe('semantic-test');
    expect(result.candidates).toHaveLength(1);
    expect(result.warning).toBe('');
  });

  it('模型异常时返回规则回退提示而不是中断上传', async () => {
    const result = await analyzeExcelSemantics(input, {
      complete: async () => { throw new Error('network down'); },
    });
    expect(result.candidates).toEqual([]);
    expect(result.warning).toContain('本地规则识别');
  });
});
