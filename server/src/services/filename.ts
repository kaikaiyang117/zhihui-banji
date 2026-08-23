import type { Database } from 'better-sqlite3';

import { getCurrentScope } from './context.js';

/** 将用户可配置或业务生成的文本转换为安全、可读的文件名片段。 */
export function filenamePart(value: unknown, fallback = '未命名'): string {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function scopeFilenamePrefix(conn?: Database): string {
  const scope = getCurrentScope({ conn });
  return `${filenamePart(scope.class_name, '当前班级')}-${filenamePart(scope.term_name, '当前学期')}`;
}

export function scopedExportFilename(
  label: unknown, extension = 'xlsx', conn?: Database,
): string {
  return `${scopeFilenamePrefix(conn)}-${filenamePart(label)}.${extension}`;
}
