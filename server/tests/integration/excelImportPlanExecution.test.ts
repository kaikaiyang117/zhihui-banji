import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkbenchDb } from '../../src/db/connection.js';
import { getCurrentScope, resetRequestScope, setDatabase } from '../../src/services/context.js';
import { createArtifactFromBuffer, inspectArtifact } from '../../src/excel/artifacts/artifactService.js';
import { createImportPlan, getImportPlan } from '../../src/excel/imports/importPlanRepository.js';
import { previewImportPlan, executeImportPlan } from '../../src/excel/imports/importPlanService.js';
import { invokeToolAsync } from '../../src/agent/agentService.js';
import { confirmActionAsync } from '../../src/agent/actions.js';

let tempDir: string;
let db: WorkbenchDb;

async function workbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('学生数据');
  sheet.addRow(['学号', '姓名', '性别']);
  sheet.addRow(['ST-001', '蓝同学', '男']);
  sheet.addRow(['ST-002', '林同学', '女']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function access(sessionId = 'web:excel-import-session') {
  const scope = getCurrentScope();
  return {
    ownerId: 'teacher-1', channel: 'web', sessionId,
    classId: scope.class_id, termId: scope.term_id,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-import-plan-'));
  db = new WorkbenchDb({ dataDir: tempDir });
  db.open();
  setDatabase(db);
  resetRequestScope();
});

afterEach(() => {
  resetRequestScope();
  db.close();
  setDatabase(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Excel ImportPlan 业务预览与统一确认执行', () => {
  it('生成真实业务预览，确认后备份、导入、验证并保持幂等', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '学生导入.xlsx', access: current,
    });
    const inspected = await inspectArtifact(artifact.id, current);
    const region = inspected.blueprint?.sheets[0].regions[0];
    expect(region).toBeDefined();

    const plan = createImportPlan({
      id: 'students-plan-1', artifactId: artifact.id, adapterId: 'students', sheetIndex: 0,
      regionId: region!.id, mappings: [
        { sourceColumn: '学号', targetField: '学号', source: 'rule', confidence: 1, status: 'accepted' },
        { sourceColumn: '姓名', targetField: '姓名', source: 'rule', confidence: 1, status: 'accepted' },
        { sourceColumn: '性别', targetField: '性别', source: 'rule', confidence: 1, status: 'accepted' },
      ], options: { duplicateStrategy: 'update' }, access: current,
    });

    const previewed = await previewImportPlan(plan.id, current);
    expect(previewed.status).toBe('awaiting_confirmation');
    expect(previewed.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(previewed.preview).toMatchObject({
      module: 'students', total_rows: 2, valid_rows: 2, new_count: 2, error_rows: 0,
    });
    expect(db.connInstance.prepare('SELECT COUNT(*) AS count FROM students').get()).toMatchObject({ count: 0 });

    const pending = await invokeToolAsync('execute_excel_import', {
      plan_id: plan.id, preview_hash: previewed.previewHash,
    }, { channel: 'web', actorId: current.ownerId, sessionId: current.sessionId });
    expect(pending.confirmation_required).toBe(true);
    const actionId = Number(pending.action_id);

    const executed = await confirmActionAsync(actionId, {
      sessionId: current.sessionId, actorId: current.ownerId,
    });
    expect(executed.status).toBe('executed');
    expect(executed.backup_file).toBeTruthy();
    expect(fs.existsSync(path.join(db.backupDir(), String(executed.backup_file)))).toBe(true);
    expect(executed.result).toMatchObject({
      plan_id: plan.id, status: 'executed', verification: { verified: true },
    });
    expect(getImportPlan(plan.id, current)?.status).toBe('executed');
    expect(db.connInstance.prepare('SELECT COUNT(*) AS count FROM students').get()).toMatchObject({ count: 2 });

    const duplicate = await confirmActionAsync(actionId, {
      sessionId: current.sessionId, actorId: current.ownerId,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(db.connInstance.prepare('SELECT COUNT(*) AS count FROM students').get()).toMatchObject({ count: 2 });
  });

  it('预览哈希不匹配时拒绝执行且不写入业务数据', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '哈希校验.xlsx', access: current,
    });
    const inspected = await inspectArtifact(artifact.id, current);
    const regionId = inspected.blueprint!.sheets[0].regions[0].id;
    const plan = createImportPlan({
      id: 'students-plan-hash', artifactId: artifact.id, adapterId: 'students', sheetIndex: 0,
      regionId, mappings: [], options: {}, access: current,
    });
    const previewed = await previewImportPlan(plan.id, current);
    await expect(executeImportPlan({
      id: plan.id, previewHash: `${previewed.previewHash}-changed`, requestId: 'hash-test', access: current,
    })).rejects.toThrow(/预览已失效/);
    expect(db.connInstance.prepare('SELECT COUNT(*) AS count FROM students').get()).toMatchObject({ count: 0 });
    expect(getImportPlan(plan.id, current)?.status).toBe('awaiting_confirmation');
  });
});
