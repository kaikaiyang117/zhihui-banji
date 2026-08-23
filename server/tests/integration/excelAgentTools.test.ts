import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

import { WorkbenchDb } from '../../src/db/connection.js';
import { getCurrentScope, resetRequestScope, setDatabase } from '../../src/services/context.js';
import { createArtifactFromBuffer, inspectArtifact } from '../../src/excel/artifacts/artifactService.js';
import { invokeToolAsync } from '../../src/agent/agentService.js';

let tempDir: string;
let db: WorkbenchDb;

async function workbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('学生数据');
  sheet.addRow(['学号', '姓名', '分数']);
  sheet.addRow(['ST-001', '蓝同学', 98]);
  sheet.addRow(['ST-002', '林同学', 86]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function access() {
  const scope = getCurrentScope();
  return {
    ownerId: 'tool-user', channel: 'web', sessionId: 'web:tool-session',
    classId: scope.class_id, termId: scope.term_id,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-agent-tools-'));
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

describe('Excel Agent 只读工具', () => {
  it('检查结构、区域和统计，不向默认结果暴露单元格值', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '工具.xlsx', access: current,
    });
    await inspectArtifact(artifact.id, current);
    const inspect = await invokeToolAsync('excel_inspect_workbook', { artifact_id: artifact.id }, {
      channel: 'web', actorId: 'tool-user', sessionId: current.sessionId,
    });
    expect(inspect.blueprint).toMatchObject({ sheets: [{ name: '学生数据' }] });
    expect(JSON.stringify(inspect)).not.toContain('ST-001');

    const list = await invokeToolAsync('excel_list_regions', { artifact_id: artifact.id }, {
      channel: 'web', actorId: 'tool-user', sessionId: current.sessionId,
    });
    const region = (list.sheets as Array<Record<string, unknown>>)[0].regions as Array<Record<string, unknown>>;
    expect(region[0].id).toBe('sheet-1-region-1');

    const profile = await invokeToolAsync('excel_profile_region', {
      artifact_id: artifact.id, region_id: region[0].id,
    }, { channel: 'web', actorId: 'tool-user', sessionId: current.sessionId });
    expect(profile).toMatchObject({ row_count: 2, column_count: 3, exposure_policy: 'structure_only' });
    expect(JSON.stringify(profile)).not.toContain('蓝同学');
  });

  it('读取范围默认只返回结构，显式允许时才返回值', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '读取.xlsx', access: current,
    });
    await inspectArtifact(artifact.id, current);
    const base = { artifact_id: artifact.id, range: 'A1:C3' };
    const structure = await invokeToolAsync('excel_read_range', base, {
      channel: 'web', actorId: 'tool-user', sessionId: current.sessionId,
    });
    expect(structure.rows).toBeUndefined();
    expect(structure.headers).toEqual(['学号', '姓名', '分数']);
    expect(JSON.stringify(structure)).not.toContain('ST-001');

    const allowed = await invokeToolAsync('excel_read_range', {
      ...base, exposure_policy: 'allowed_values',
    }, { channel: 'web', actorId: 'tool-user', sessionId: current.sessionId });
    expect(allowed.rows).toEqual([
      ['学号', '姓名', '分数'], ['ST-001', '蓝同学', '98'], ['ST-002', '林同学', '86'],
    ]);
  });

  it('跨会话读取被拒绝，微信不能调用敏感范围读取', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '隔离.xlsx', access: current,
    });
    await expect(invokeToolAsync('excel_read_range', {
      artifact_id: artifact.id, range: 'A1:C2',
    }, { channel: 'web', actorId: 'tool-user', sessionId: 'web:other-session' })).rejects.toThrow(/不属于当前会话/);
    await expect(invokeToolAsync('excel_read_range', {
      artifact_id: artifact.id, range: 'A1:C2',
    }, { channel: 'wechat', actorId: 'tool-user', sessionId: 'wechat:tool-session' })).rejects.toThrow(/敏感|权限/);
  });

  it('创建和修改导入草稿计划不会写业务数据，并会使旧预览失效', async () => {
    const current = access();
    const artifact = createArtifactFromBuffer({
      buffer: await workbookBuffer(), filename: '计划工具.xlsx', access: current,
    });
    const inspected = await inspectArtifact(artifact.id, current);
    const regionId = inspected.blueprint?.sheets[0].regions[0].id;
    const created = await invokeToolAsync('excel_create_import_plan', {
      artifact_id: artifact.id, adapter_id: 'students', region_id: regionId,
      mappings: [{ sourceColumn: '学号', targetField: '学号', source: 'rule', confidence: 1, status: 'accepted' }],
      options: { duplicateStrategy: 'update' },
    }, { channel: 'web', actorId: 'tool-user', sessionId: current.sessionId });
    const plan = created.plan as Record<string, unknown>;
    expect(plan.status).toBe('draft');
    expect(plan.previewHash).toBe('');

    const updated = await invokeToolAsync('excel_update_import_plan', {
      plan_id: plan.id, mappings: [{ sourceColumn: '姓名', targetField: '姓名', source: 'manual', confidence: 1, status: 'accepted' }],
    }, { channel: 'web', actorId: 'tool-user', sessionId: current.sessionId });
    expect((updated.plan as Record<string, unknown>).planHash).not.toBe(plan.planHash);
    expect(db.connInstance.prepare('SELECT COUNT(*) AS count FROM students').get()).toMatchObject({ count: 0 });
  });
});
