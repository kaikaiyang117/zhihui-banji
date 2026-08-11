/* MIG-04 文件安全：路径白名单、原子写入、哈希与临时文件清理。
 * 供后续 MIG（附件/导入/知识库/备份）复用，本工作包只交付能力与测试。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class FileSafetyError extends Error {}

/** 校验相对路径并解析到根目录内；拒绝绝对路径与目录穿越。 */
export function safeResolve(root: string, relative: string): string {
  const value = String(relative ?? '').replace(/\\/g, '/');
  if (value.startsWith('/')) {
    throw new FileSafetyError('不允许使用绝对路径');
  }
  const resolved = path.resolve(root, value);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new FileSafetyError('文件路径超出允许目录');
  }
  return resolved;
}

/** 原子写入：先写临时文件再 rename，失败清理临时文件。 */
export function atomicWrite(target: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 清理失败不影响原始错误
    }
    throw error;
  }
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 清理目录中符合模式且超过保留时长的临时文件。 */
export function cleanTempFiles(
  dir: string,
  options: { pattern?: RegExp; olderThanMs?: number; onError?: (error: Error, file: string) => void } = {},
): number {
  if (!fs.existsSync(dir)) return 0;
  const pattern = options.pattern ?? /\.tmp$/;
  const olderThanMs = options.olderThanMs ?? 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!pattern.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (olderThanMs > 0 && Date.now() - stat.mtimeMs < olderThanMs) continue;
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch (error) {
      options.onError?.(error as Error, file);
    }
  }
  return removed;
}
