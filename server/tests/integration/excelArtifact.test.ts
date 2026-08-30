import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

import { WorkbenchDb } from '../../src/db/connection.js';
import {
  bindRequestScope, getCurrentScope, resetRequestScope, setDatabase,
} from '../../src/services/context.js';
import {
  cleanExpiredArtifacts, createArtifactFromBuffer, discardArtifact, inspectArtifact,
} from '../../src/excel/artifacts/artifactService.js';
import {
  getArtifact, requireArtifact,
} from '../../src/excel/artifacts/artifactRepository.js';
import {
  createImportPlan, getImportPlan, saveImportPreview, updateImportPlan,
} from '../../src/excel/imports/importPlanRepository.js';

let tempDir: string;
let db: WorkbenchDb;

async function workbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('学生数据');
  sheet.addRow(['学号', '姓名', '分数']);
  sheet.addRow(['ST-001', '蓝同学', 98]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function access(sessionId = 'excel-session') {
  const scope = getCurrentScope();
  return {
    ownerId: 'teacher-1', channel: 'web', sessionId,
    classId: scope.class_id, termId: scope.term_id,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-artifact-'));
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
  delete process.env.WORKBENCH_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('WorkbookArtifact 与 ImportPlan', () => {
  it('保存结构蓝图但不把单元格值写入数据库', async () => {
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '学生成绩.xlsx', access: access(),
    });
    expect(artifact.status).toBe('uploaded');
    expect(artifact.blueprint).toBeNull();
    const inspected = await inspectArtifact(artifact.id, access());

    expect(inspected.status).toBe('inspected');
    expect(inspected.blueprint?.sheets[0]).toMatchObject({
      name: '学生数据', rowCount: 2, columnCount: 3,
    });
    expect(inspected.blueprint?.sheets[0].regions[0].headers).toEqual(['学号', '姓名', '分数']);
    expect(JSON.stringify(inspected.blueprint)).not.toContain('ST-001');
    expect(JSON.stringify(inspected.blueprint)).not.toContain('蓝同学');
    expect(db.connInstance.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get())
      .toMatchObject({ version: 38 });
  });

  it('计划绑定 Artifact、范围和双层哈希，变更映射会使旧预览失效', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '计划.xlsx', access: current,
    });
    await inspectArtifact(artifact.id, current);
    const regionId = requireArtifact(artifact.id, current).blueprint?.sheets[0].regions[0].id ?? '';
    const plan = createImportPlan({
      id: 'plan-1', artifactId: artifact.id, adapterId: 'students', sheetIndex: 0,
      regionId, mappings: [{
        sourceColumn: '学号', targetField: '学号', source: 'rule', confidence: 1,
        status: 'accepted',
      }], options: { duplicateStrategy: 'update' }, access: current,
    });
    const previewed = saveImportPreview('plan-1', { validRows: 1, errors: 0 }, current);
    expect(previewed.status).toBe('awaiting_confirmation');
    expect(previewed.previewHash).toMatch(/^[a-f0-9]{64}$/);

    const updated = updateImportPlan({
      id: 'plan-1', access: current,
      mappings: [{
        sourceColumn: '姓名', targetField: '姓名', source: 'manual', confidence: 1,
        status: 'accepted',
      }],
    });
    expect(updated.planHash).not.toBe(plan.planHash);
    expect(updated.previewHash).toBe('');
    expect(updated.status).toBe('draft');
    expect(getImportPlan('plan-1', current)?.classId).toBe(current.classId);
  });

  it('按所有者、渠道、会话和范围隔离 Artifact', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '隔离.xlsx', access: current,
    });
    expect(getArtifact(artifact.id, access('other-session'))).toBeNull();
    expect(() => requireArtifact(artifact.id, access('other-session'))).toThrow(/不属于当前会话/);

    const other = { ...current, channel: 'wechat' };
    expect(getArtifact(artifact.id, other)).toBeNull();
  });

  it('取消或清理 Artifact 时移除受控文件', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '清理.xlsx', access: current,
    });
    const stored = path.join(tempDir, artifact.storagePath);
    expect(fs.existsSync(stored)).toBe(true);
    discardArtifact(artifact.id, current);
    expect(fs.existsSync(stored)).toBe(false);
    expect(getArtifact(artifact.id, current)?.status).toBe('discarded');

    const second = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '过期.xlsx', access: current,
    });
    db.connInstance.prepare(
      "UPDATE excel_artifacts SET expires_at='2000-01-01 00:00:00' WHERE id=?",
    ).run(second.id);
    expect(cleanExpiredArtifacts()).toBe(1);
    expect(getArtifact(second.id, current)).toBeNull();
  });

  it('切换范围后无法读取原 Artifact', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '范围.xlsx', access: current,
    });
    const classRow = db.connInstance.prepare("INSERT INTO classes(name) VALUES('二班')").run();
    const classId = Number(classRow.lastInsertRowid);
    const termRow = db.connInstance.prepare(
      "INSERT INTO terms(class_id, name, status) VALUES(?, '当前学期', '进行中')",
    ).run(classId);
    bindRequestScope(classId, Number(termRow.lastInsertRowid));
    const switched = access();
    expect(getArtifact(artifact.id, switched)).toBeNull();
  });
});
