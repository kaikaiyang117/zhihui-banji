/* MIG-01 试验 B：exceljs 读取黄金工作簿并与 openpyxl 语义快照比对。

对 migrate/mig-01/out/excel/*.xlsx：
1. 用 exceljs 提取语义（sheet 名/维度/合并/冻结/列宽/单元格值/日期/公式/加粗）
2. 与同名的 *.openpyxl.json 快照逐项比对
3. 反向验证：exceljs 生成带合并/冻结/日期/公式的工作簿，openpyxl 读回比对
*/
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const MIG01 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(MIG01, 'out', 'excel');

const results: { checks: { name: string; ok: boolean; detail: string }[]; total?: number; passed?: number; ok?: boolean } = { checks: [] };
function check(name: string, ok: boolean, detail = '') {
  results.checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function colLetter(index: number) {
  let s = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellSemantics(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) return { kind: 'empty' };
  if (value instanceof Date) {
    return { kind: 'd', v: value.toISOString().slice(0, 10), bold: Boolean(cell.font?.bold), fmt: normalizeFmt(cell.numFmt) };
  }
  if (typeof value === 'string') {
    return { kind: 's', v: value, bold: Boolean(cell.font?.bold), fmt: normalizeFmt(cell.numFmt) };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: typeof value === 'number' ? 'n' : 'b', v: value, bold: Boolean(cell.font?.bold), fmt: normalizeFmt(cell.numFmt) };
  }
  if (typeof value === 'object' && value !== null && 'formula' in value && typeof (value as { formula?: unknown }).formula === 'string') {
    return { kind: 'f', v: `=${(value as { formula: string }).formula}`, bold: Boolean(cell.font?.bold), fmt: normalizeFmt(cell.numFmt) };
  }
  return { kind: 'empty' };
}

function normalizeDims(dims: { model?: { top: number; left: number; bottom: number; right: number } } | ExcelJS.Range | null | undefined) {
  const m = (dims as { model?: { top: number; left: number; bottom: number; right: number } } | null | undefined)?.model;
  if (!m || !m.right) return 'A1:A1';
  const tl = `${colLetter(m.left)}${m.top}`;
  const br = `${colLetter(m.right)}${m.bottom}`;
  return tl === br ? tl : `${tl}:${br}`;
}

function normalizeFmt(fmt: string) {
  // openpyxl 默认 number_format 为 'General'，exceljs 为 ''，等价。
  return fmt === 'General' ? '' : (fmt || '');
}

// 被合并覆盖（非主格）的单元格：openpyxl 返回空，exceljs 会返回主值，需归一化。
function coveredCells(merges: string[]) {
  const covered = new Set();
  for (const range of merges) {
    const m = String(range).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) continue;
    const c1 = colLetterToIndex(m[1]), c2 = colLetterToIndex(m[3]);
    const r1 = Number(m[2]), r2 = Number(m[4]);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue; // 主格保留
        covered.add(`${r}:${c}`);
      }
    }
  }
  return covered;
}

function colLetterToIndex(letters: string) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

async function exceljsSemantics(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = [];
  for (const ws of wb.worksheets) {
    const merges = (ws.model.merges || []).map((m) => String(m)).sort();
    const covered = coveredCells(merges);
    const view = ws.views?.[0];
    let freeze = '';
    if (view?.state === 'frozen') {
      freeze = view.topLeftCell || `${colLetter((view.xSplit || 0) + 1)}${(view.ySplit || 0) + 1}`;
    }
    const widths: Record<string, number> = {};
    (ws.columns || []).forEach((col, index) => {
      if (col && col.width !== undefined && !col.hidden) widths[colLetter(index + 1)] = Math.round(col.width * 100) / 100;
    });
    const maxRow = ws.rowCount, maxCol = ws.columnCount;
    const grid = [];
    for (let r = 1; r <= maxRow; r++) {
      const row = [];
      for (let c = 1; c <= maxCol; c++) {
        row.push(covered.has(`${r}:${c}`) ? { kind: 'empty' } : cellSemantics(ws.getCell(r, c)));
      }
      grid.push(row);
    }
    sheets.push({ name: ws.name, dims: normalizeDims(ws.dimensions), freeze, merges, widths, grid });
  }
  return { sheets };
}

function compareSemantics(openpyxl: unknown, exceljs: unknown, label: string) {
  const diffs: string[] = [];
  const jsonA = JSON.stringify(openpyxl);
  const jsonB = JSON.stringify(exceljs);
  if (jsonA === jsonB) return { equal: true, diffs: [] };
  // 逐级找出首个差异
  const walk = (a: unknown, b: unknown, p: string) => {
    if (typeof a !== typeof b) { diffs.push(`${p}: 类型 ${typeof a} vs ${typeof b}`); return; }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) { diffs.push(`${p}: 长度 ${a.length} vs ${b.length}`); return; }
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${p}[${i}]`);
      return;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        if (JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k])) {
          walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${p}.${k}`);
        }
      }
      return;
    }
    if (a !== b) diffs.push(`${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  };
  walk(openpyxl, exceljs, label);
  return { equal: diffs.length === 0, diffs: diffs.slice(0, 5) };
}

// ---------- 1. 读回比对 ----------
const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.xlsx')).sort();
for (const file of files) {
  const base = file.replace(/\.xlsx$/, '');
  const openpyxlPath = path.join(OUT, `${base}.openpyxl.json`);
  if (!fs.existsSync(openpyxlPath)) continue;
  const openpyxl = JSON.parse(fs.readFileSync(openpyxlPath, 'utf-8'));
  const exceljs = await exceljsSemantics(path.join(OUT, file));
  const { equal, diffs } = compareSemantics(openpyxl, exceljs, file);
  check(`exceljs 读取 ${file} 与 openpyxl 语义一致`, equal, diffs.join('；'));
}

// ---------- 2. 反向：exceljs 生成 → openpyxl 读回 ----------
{
  // 关键约定：openpyxl/exceljs 都以“朴素本地日期”写序列号。
  // 直接写 JS Date 会被 exceljs 按 UTC 转换，导致时区偏移（4 月 15 日写成 14 日）。
  // 必须按本地日历分量计算序列号（1899-12-30 起算），与 openpyxl 一致。
  function naiveDateSerial(date: Date) {
    const epoch = Date.UTC(1899, 11, 30);
    const local = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((local - epoch) / 86400000);
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('回读测试');
  ws.mergeCells('A1:B1');
  ws.getCell('A1').value = '合并标题';
  ws.getCell('A1').font = { bold: true };
  ws.getCell('C1').value = naiveDateSerial(new Date(2026, 3, 15));
  ws.getCell('C1').numFmt = 'yyyy-mm-dd';
  ws.getCell('A2').value = '=SUM(1,2)';
  ws.getCell('B2').value = 42;
  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 12;
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];
  const gen = path.join(OUT, 'generated-by-exceljs.xlsx');
  await wb.xlsx.writeFile(gen);
  const readBack = execFileSync(
    process.env.WORKBENCH_PYTHON || 'python3',
    [path.join(MIG01, 'scripts', 'read-semantics.py'), gen], { encoding: 'utf-8' });
  const openpyxl = JSON.parse(readBack);
  const mine = await exceljsSemantics(gen);
  const { equal, diffs } = compareSemantics(openpyxl, mine, 'generated-by-exceljs');
  check('exceljs 生成 → openpyxl 读回一致（合并/冻结/列宽/日期/公式）', equal, diffs.join('；'));
}

const passed = results.checks.filter((c) => c.ok).length;
results.total = results.checks.length;
results.passed = passed;
results.ok = passed === results.checks.length;
fs.writeFileSync(path.join(OUT, 'exceljs-report.json'), JSON.stringify(results, null, 2));
console.log(`\nExcel 试验：${passed}/${results.checks.length} 通过`);
process.exit(results.ok ? 0 : 1);
