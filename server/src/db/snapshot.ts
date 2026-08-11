/* MIG-03 schema 快照：与 MIG-00 基线 common.py 的 schema_snapshot/row_counts 结构一致，
 * 用于 Node 引擎与 Python 基线的逐项比对。 */
import type { Database } from 'better-sqlite3';

export interface SchemaSnapshot {
  version: number;
  tables: Record<string, unknown>;
  triggers: Array<Record<string, unknown>>;
}

export function schemaSnapshot(conn: Database): SchemaSnapshot {
  const tables: Record<string, unknown> = {};
  const master = conn.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') "
    + "AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string; type: string }>;
  for (const { name, type } of master) {
    if (type === 'table') {
      const columns = (conn.pragma(`table_info("${name}")`) as Array<{
        name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
      }>).map((col) => ({
        name: col.name,
        type: col.type,
        notnull: Boolean(col.notnull),
        default: col.dflt_value,
        pk: col.pk,
      }));
      const indexes = (conn.pragma(`index_list("${name}")`) as Array<{
        name: string; unique: number; origin: string;
      }>).map((idx) => ({
        name: idx.name,
        unique: Boolean(idx.unique),
        origin: idx.origin,
        columns: (conn.pragma(`index_info("${idx.name}")`) as Array<{ name: string }>)
          .map((row) => row.name),
      }));
      const foreignKeys = (conn.pragma(`foreign_key_list("${name}")`) as Array<{
        table: string; from: string; to: string; on_update: string; on_delete: string;
      }>).map((fk) => ({
        table: fk.table,
        from: fk.from,
        to: fk.to,
        on_update: fk.on_update,
        on_delete: fk.on_delete,
      }));
      tables[name] = { kind: type, columns, indexes, foreign_keys: foreignKeys };
    } else {
      tables[name] = { kind: type };
    }
  }
  const triggers = conn.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
  ).all() as Array<Record<string, unknown>>;
  const version = (conn.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    { v: number | null }).v ?? 0;
  return { version, tables, triggers };
}

export function rowCounts(conn: Database): Record<string, number> {
  const counts: Record<string, number> = {};
  const tables = conn.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    counts[name] = (conn.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
  }
  return counts;
}
