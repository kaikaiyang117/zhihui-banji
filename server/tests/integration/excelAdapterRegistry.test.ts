import { describe, expect, it } from 'vitest';

import { getImportAdapter, listImportAdapters } from '../../src/excel/imports/adapterRegistry.js';

describe('ExcelImportAdapter 注册表', () => {
  it('只登记四类首期稳定业务导入', () => {
    expect(listImportAdapters().map(adapter => adapter.id)).toEqual([
      'students', 'scores', 'calendar', 'timetable',
    ]);
  });

  it('每个 Adapter 暴露自己的字段和重复策略', () => {
    const students = getImportAdapter('students');
    const calendar = getImportAdapter('calendar');
    expect(students.fields().find(field => field.target === '学号')).toMatchObject({ required: true });
    expect(students.duplicateStrategies()).toEqual(['update', 'skip']);
    expect(calendar.duplicateStrategies()).toEqual(['merge', 'skip', 'conflict']);
  });

  it('未知类型不会静默降级到另一个业务模块', () => {
    expect(() => getImportAdapter('attendance')).toThrow(/不支持/);
  });
});
