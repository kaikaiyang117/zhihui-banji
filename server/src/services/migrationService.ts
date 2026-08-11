import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';

import { loadAppVersion } from '../config/index.js';
import { CURRENT_SCHEMA_VERSION } from '../db/schema.js';
import { getDb } from './context.js';
import { sha256File } from './files.js';

export const PACKAGE_FORMAT = 'meimei-workbench-migration';
export const PACKAGE_VERSION = 1;
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
export const MAX_MEMBER_BYTES = 200 * 1024 * 1024;
export const MAX_MEMBER_COUNT = 100_000;
export const EXCLUDED_DATA_FILES: ReadonlySet<string> = new Set([
  'workbench.db', 'workbench.db-wal', 'workbench.db-shm',
  'agent-model.json', 'wechat-config.json', 'wechat-credentials.json', 'github-token.json', 'agent-checkpoints.db',
  'agent-checkpoints.db-wal', 'agent-checkpoints.db-shm', '.workbench-ready',
]);
export const EXCLUDED_DATA_DIRS: ReadonlySet<string> = new Set(['backups']);

export class MigrationError extends Error {}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipOutEntry {
  name: string;
  data: Buffer;
  mode: number;
}

function zipCreate(entries: ZipOutEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(0x031e, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0x0800, 8);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt16LE(dosTime, 12);
    centralEntry.writeUInt16LE(dosDate, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(name.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(((entry.mode & 0xffff) << 16) >>> 0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, name);
    offset += 30 + name.length + compressed.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, eocd]);
}

class ZipFormatError extends Error {}

interface ZipMember {
  name: string;
  isDir: boolean;
  method: number;
  fileSize: number;
  compressedSize: number;
  crc: number;
  externalAttr: number;
  localOffset: number;
}

function parseZip(data: Buffer): ZipMember[] {
  if (data.length < 22) throw new ZipFormatError();
  const searchFrom = Math.max(0, data.length - 22 - 0xffff);
  let eocd = -1;
  for (let index = data.length - 22; index >= searchFrom; index -= 1) {
    if (data.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError();
  if (data.readUInt16LE(eocd + 4) !== 0 || data.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipFormatError();
  }
  let count = data.readUInt16LE(eocd + 10);
  let centralSize = data.readUInt32LE(eocd + 12);
  let centralOffset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    if (eocd - 20 < 0 || data.readUInt32LE(eocd - 20) !== 0x07064b50) throw new ZipFormatError();
    const zip64Offset = Number(data.readBigUInt64LE(eocd - 12));
    if (zip64Offset + 56 > data.length || data.readUInt32LE(zip64Offset) !== 0x06064b50) {
      throw new ZipFormatError();
    }
    count = Number(data.readBigUInt64LE(zip64Offset + 24));
    centralSize = Number(data.readBigUInt64LE(zip64Offset + 40));
    centralOffset = Number(data.readBigUInt64LE(zip64Offset + 48));
  }
  if (centralOffset > data.length || centralSize > data.length - centralOffset) {
    throw new ZipFormatError();
  }
  const members: ZipMember[] = [];
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > centralEnd) throw new ZipFormatError();
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new ZipFormatError();
    const flags = data.readUInt16LE(cursor + 8);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    if (cursor + 46 + nameLength + extraLength + commentLength > centralEnd) {
      throw new ZipFormatError();
    }
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = (flags & 0x0800) !== 0
      ? nameBytes.toString('utf-8')
      : nameBytes.toString('latin1');
    const externalAttr = data.readUInt32LE(cursor + 38);
    members.push({
      name,
      isDir: name.endsWith('/') || (externalAttr & 0x10) !== 0,
      method: data.readUInt16LE(cursor + 10),
      fileSize: data.readUInt32LE(cursor + 24),
      compressedSize: data.readUInt32LE(cursor + 20),
      crc: data.readUInt32LE(cursor + 16),
      externalAttr,
      localOffset: data.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

function readMember(member: ZipMember, data: Buffer): Buffer {
  const offset = member.localOffset;
  if (offset + 30 > data.length || data.readUInt32LE(offset) !== 0x04034b50) {
    throw new ZipFormatError();
  }
  const nameLength = data.readUInt16LE(offset + 26);
  const extraLength = data.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  if (start + member.compressedSize > data.length) throw new ZipFormatError();
  const raw = data.subarray(start, start + member.compressedSize);
  let content: Buffer;
  if (member.method === 0) {
    content = Buffer.from(raw);
  } else if (member.method === 8) {
    try {
      content = zlib.inflateRawSync(raw);
    } catch {
      throw new ZipFormatError();
    }
  } else {
    throw new ZipFormatError();
  }
  return content.subarray(0, member.fileSize);
}

function testZip(members: ZipMember[], data: Buffer): string | null {
  for (const member of members) {
    if (member.isDir) continue;
    try {
      if (crc32(readMember(member, data)) !== member.crc) return member.name;
    } catch {
      return member.name;
    }
  }
  return null;
}

function safeArchivePath(name: string): string {
  if (!name || name.includes('\\') || name.startsWith('/')) {
    throw new MigrationError('迁移包包含不安全的文件路径');
  }
  const parts = name.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new MigrationError('迁移包包含不安全的文件路径');
  }
  return parts.join('/');
}

function readManifest(
  members: ZipMember[], data: Buffer,
): { manifest: Record<string, unknown>; entries: Array<Record<string, unknown>> } {
  if (members.length > MAX_MEMBER_COUNT) throw new MigrationError('迁移包文件数量过多');
  const names = new Set<string>();
  for (const info of members) {
    const name = safeArchivePath(info.name);
    if (names.has(name)) throw new MigrationError('迁移包包含重复文件');
    names.add(name);
    const mode = (info.externalAttr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new MigrationError('迁移包不支持符号链接');
    if (!info.isDir && info.fileSize > MAX_MEMBER_BYTES) {
      throw new MigrationError('迁移包中的单个文件过大');
    }
  }
  const manifestEntry = members.find((info) => !info.isDir && info.name === 'manifest.json');
  if (!manifestEntry) throw new MigrationError('迁移包缺少清单文件');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readMember(manifestEntry, data).toString('utf-8'));
  } catch {
    throw new MigrationError('迁移包清单无法读取');
  }
  if (typeof manifest !== 'object' || manifest === null) {
    throw new MigrationError('迁移包清单无法读取');
  }
  const manifestObj = manifest as Record<string, unknown>;
  if (manifestObj['format'] !== PACKAGE_FORMAT || manifestObj['format_version'] !== PACKAGE_VERSION) {
    throw new MigrationError('迁移包版本不受当前工作台支持');
  }
  const entriesValue = manifestObj['entries'];
  if (!Array.isArray(entriesValue) || entriesValue.length === 0) {
    throw new MigrationError('迁移包清单为空');
  }
  const entries = entriesValue as Array<Record<string, unknown>>;
  const manifestPaths = new Set<string>();
  for (const rawEntry of entries) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new MigrationError('迁移包清单格式不正确');
    }
    const entry = rawEntry as Record<string, unknown>;
    const entryPath = safeArchivePath(String(entry['path'] ?? ''));
    if (manifestPaths.has(entryPath) || entryPath === 'manifest.json') {
      throw new MigrationError('迁移包清单包含重复文件');
    }
    const kind = entry['kind'];
    if (kind !== 'database' && kind !== 'data' && kind !== 'knowledge') {
      throw new MigrationError('迁移包清单包含未知文件类型');
    }
    if (kind === 'database' && entryPath !== 'database/workbench.db') {
      throw new MigrationError('迁移包数据库路径不正确');
    }
    if (kind === 'data' && !entryPath.startsWith('data/')) {
      throw new MigrationError('迁移包业务文件路径不正确');
    }
    if (kind === 'knowledge' && !entryPath.startsWith('knowledge/')) {
      throw new MigrationError('迁移包知识库文件路径不正确');
    }
    const size = entry['size'];
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new MigrationError('迁移包清单中的文件大小不正确');
    }
    const digest = entry['sha256'];
    if (typeof digest !== 'string' || digest.length !== 64) {
      throw new MigrationError('迁移包清单中的校验值不正确');
    }
    manifestPaths.add(entryPath);
  }
  const archivePaths = new Set<string>();
  for (const info of members) {
    if (info.isDir || info.name === 'manifest.json') continue;
    archivePaths.add(safeArchivePath(info.name));
  }
  if (archivePaths.size !== manifestPaths.size
    || !manifestPaths.has('database/workbench.db')
    || [...manifestPaths].some((item) => !archivePaths.has(item))) {
    throw new MigrationError('迁移包清单与文件内容不一致');
  }
  const totalSize = members.reduce((sum, info) => sum + info.fileSize, 0);
  if (totalSize > MAX_PACKAGE_BYTES) throw new MigrationError('迁移包解压后过大');
  for (const entry of entries) {
    if (entry['kind'] === 'database' && String(entry['path'] ?? '') !== 'database/workbench.db') {
      throw new MigrationError('迁移包只能包含一个数据库文件');
    }
  }
  return { manifest: manifestObj, entries };
}

function validateDatabase(dbPath: string): void {
  let check: Database.Database | null = null;
  try {
    check = new Database(dbPath, { readonly: true });
    const rows = check.pragma('integrity_check') as Array<Record<string, string>>;
    const integrity = rows.length > 0 ? String(rows[0]['integrity_check'] ?? '') : '';
    if (integrity !== 'ok') throw new MigrationError('迁移包中的数据库完整性检查失败');
    const row = check.prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined;
    const sourceVersion = Number(row?.version ?? 0);
    if (sourceVersion > CURRENT_SCHEMA_VERSION) {
      throw new MigrationError('迁移包来自更新版本，请先升级当前工作台');
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError(`迁移包中的数据库无法读取：${(error as Error).message}`);
  } finally {
    if (check) check.close();
  }
}

function extract(
  members: ZipMember[], data: Buffer, stage: string, entries: Array<Record<string, unknown>>,
): void {
  const entryMap = new Map<string, Record<string, unknown>>();
  for (const entry of entries) entryMap.set(safeArchivePath(String(entry['path'] ?? '')), entry);
  const stageRoot = path.resolve(stage);
  for (const info of members) {
    const name = safeArchivePath(info.name);
    if (info.isDir || name === 'manifest.json') continue;
    const target = path.resolve(stageRoot, ...name.split('/'));
    if (!target.startsWith(stageRoot + path.sep)) {
      throw new MigrationError('迁移包包含不安全的目标路径');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readMember(info, data));
    const entry = entryMap.get(name);
    if (!entry
      || fs.statSync(target).size !== Number(entry['size'])
      || sha256File(target) !== String(entry['sha256']).toLowerCase()) {
      throw new MigrationError(`迁移包文件校验失败：${name}`);
    }
  }
}

function installTree(stage: string, archiveRoot: string, targetRoot: string): number {
  const sourceRoot = path.join(stage, archiveRoot);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) return 0;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        files.push(full);
      }
    }
  };
  walk(sourceRoot);
  const targetRootResolved = path.resolve(targetRoot);
  let count = 0;
  for (const source of files) {
    const relative = path.relative(sourceRoot, source).split(path.sep).join('/');
    const target = path.resolve(targetRootResolved, ...relative.split('/'));
    if (!target.startsWith(targetRootResolved + path.sep)) {
      throw new MigrationError('迁移包包含不安全的目标路径');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.migration-tmp`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, target);
    count += 1;
  }
  return count;
}

function iterFiles(
  root: string, prefix: string,
  excludedFiles?: ReadonlySet<string>, excludedDirs?: ReadonlySet<string>,
): Array<[string, string]> {
  const rootPath = path.resolve(root);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) return [];
  const result: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (excludedDirs?.has(name)) continue;
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      if (excludedFiles?.has(name)) continue;
      const relative = path.relative(rootPath, full).split(path.sep).join('/');
      result.push([`${prefix}/${relative}`, full]);
    }
  };
  walk(rootPath);
  return result;
}

function fileEntry(archivePath: string, sourcePath: string, kind: string): Record<string, unknown> {
  return {
    path: archivePath,
    kind,
    size: fs.statSync(sourcePath).size,
    sha256: sha256File(sourcePath),
  };
}

function timestampMicro(): string {
  const now = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  const micro = String(Math.floor(now.getMilliseconds() * 1000)).padStart(6, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${micro}`;
}

function isoSeconds(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function createPackage(): Promise<string> {
  const db = getDb();
  fs.mkdirSync(db.paths.backupsDir, { recursive: true });
  const databaseBackup = await db.createBackup('migration');
  const databasePath = path.join(db.paths.backupsDir, databaseBackup);
  const entries: Array<Record<string, unknown>> = [
    fileEntry('database/workbench.db', databasePath, 'database'),
  ];
  for (const [archivePath, sourcePath] of iterFiles(db.paths.dataDir, 'data', EXCLUDED_DATA_FILES, EXCLUDED_DATA_DIRS)) {
    entries.push(fileEntry(archivePath, sourcePath, 'data'));
  }
  for (const [archivePath, sourcePath] of iterFiles(db.paths.kbDir, 'knowledge')) {
    entries.push(fileEntry(archivePath, sourcePath, 'knowledge'));
  }
  const filename = `workbench-migration-${timestampMicro()}.zip`;
  const outputPath = path.join(db.paths.backupsDir, filename);
  const manifest: Record<string, unknown> = {
    format: PACKAGE_FORMAT,
    format_version: PACKAGE_VERSION,
    created_at: isoSeconds(new Date()),
    app_version: loadAppVersion(),
    schema_version: db.schemaVersion(),
    entries,
  };
  try {
    const payloads: Array<ZipOutEntry> = [];
    for (const entry of entries) {
      const sourcePath = entry['kind'] === 'database' ? databasePath
        : entry['kind'] === 'data'
          ? path.join(db.paths.dataDir, String(entry['path']).slice('data/'.length))
          : path.join(db.paths.kbDir, String(entry['path']).slice('knowledge/'.length));
      payloads.push({ name: String(entry['path']), data: fs.readFileSync(sourcePath), mode: 0o100644 });
    }
    payloads.push({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
      mode: 0o100600,
    });
    fs.writeFileSync(outputPath, zipCreate(payloads));
  } catch (error) {
    try {
      fs.rmSync(outputPath, { force: true });
    } catch {
      // 清理失败不影响原始错误
    }
    throw error;
  }
  return filename;
}

export async function restorePackage(data: Buffer): Promise<Record<string, unknown>> {
  const db = getDb();
  if (!data || data.length === 0) throw new MigrationError('迁移包为空');
  if (data.length > MAX_PACKAGE_BYTES) throw new MigrationError('迁移包过大');
  const parent = path.dirname(path.resolve(db.paths.dataDir));
  const stage = fs.mkdtempSync(path.join(parent, '.migration-import-'));
  const archivePath = path.join(stage, 'package.zip');
  try {
    fs.writeFileSync(archivePath, data);
    let members: ZipMember[] = [];
    try {
      members = parseZip(data);
      const corrupt = testZip(members, data);
      if (corrupt) throw new MigrationError(`迁移包校验失败：${corrupt}`);
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('文件不是有效的迁移包');
    }
    const { manifest, entries } = readManifest(members, data);
    extract(members, data, stage, entries);
    const stagedDb = path.join(stage, 'database', 'workbench.db');
    validateDatabase(stagedDb);
    const preRestore = await db.createBackup('pre-migration');
    db.close();
    fs.mkdirSync(path.dirname(path.resolve(db.paths.dbPath)), { recursive: true });
    fs.renameSync(stagedDb, db.paths.dbPath);
    const dataCount = installTree(stage, 'data', db.paths.dataDir);
    const knowledgeCount = installTree(stage, 'knowledge', db.paths.kbDir);
    db.open();
    return {
      ok: true,
      pre_restore_backup: preRestore,
      app_version: String(manifest['app_version'] ?? ''),
      schema_version: db.schemaVersion(),
      data_file_count: dataCount,
      knowledge_file_count: knowledgeCount,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
