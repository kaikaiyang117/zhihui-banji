#!/usr/bin/env node
/* 把 GitHub Release 产物镜像到 Gitee Releases（国内更新源）。
 *
 * 用法（在 release 流水线中）：
 *   GITEE_TOKEN=... GITEE_REPO=owner/repo RELEASE_TAG=v1.2.3 \
 *     GITHUB_REPOSITORY=owner/repo node packaging/publish-gitee.mjs <assets-dir>
 *
 * 流程：确保 tag → 清理同名旧 release → 创建 release → 上传安装包与 SHA256SUMS.txt
 * → 从 Gitee API 读回附件权威下载地址 → 生成 update-manifest.json（Gitee 版）
 * → 上传清单 → 读回校验全部产物存在。
 */
import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://gitee.com/api/v5';
const TOKEN = process.env.GITEE_TOKEN ?? '';
const REPO = process.env.GITEE_REPO ?? '';
const TAG = process.env.RELEASE_TAG ?? '';
const GH_REPO = process.env.GITHUB_REPOSITORY ?? '';
const ASSETS_DIR = path.resolve(process.argv[2] ?? 'release-assets');

if (!TOKEN) { console.error('缺少 GITEE_TOKEN'); process.exit(1); }
if (!REPO || !REPO.includes('/')) { console.error('缺少 GITEE_REPO（格式 owner/repo）'); process.exit(1); }
if (!TAG) { console.error('缺少 RELEASE_TAG'); process.exit(1); }
if (!fs.existsSync(ASSETS_DIR)) { console.error(`产物目录不存在：${ASSETS_DIR}`); process.exit(1); }

const files = fs.readdirSync(ASSETS_DIR)
  .filter((name) => !['SHA256SUMS.txt', 'update-manifest.json'].includes(name))
  .sort((a, b) => a.localeCompare(b));

const installers = files.filter((name) => /\.(exe|dmg)$/i.test(name));
if (installers.length === 0) { console.error('没有找到安装包（*.exe / *.dmg）'); process.exit(1); }
if (!fs.existsSync(path.join(ASSETS_DIR, 'SHA256SUMS.txt'))) {
  console.error('缺少 SHA256SUMS.txt'); process.exit(1);
}

const checksums = new Map();
for (const line of fs.readFileSync(path.join(ASSETS_DIR, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [digest, ...parts] = line.trim().split(/\s+/);
  checksums.set(path.basename(parts.join(' ').replace(/^\*/, '')), digest.toLowerCase());
}

async function api(method, pathname, { json, form, token = true } = {}) {
  let url = `${API_BASE}${pathname}`;
  const options = { method, headers: {} };
  if (token) url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}`;
  if (json !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(json);
  }
  if (form !== undefined) options.body = form;
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data && typeof data === 'object' ? (data.message ?? JSON.stringify(data)) : String(data);
    throw new Error(`${method} ${pathname} → HTTP ${response.status}: ${detail}`);
  }
  return data;
}

async function headSha() {
  const repo = await api('GET', `/repos/${REPO}`);
  const defaultBranch = repo.default_branch;
  if (!defaultBranch) {
    console.error('Gitee 仓库没有默认分支（仓库为空？）。请先在 Gitee 仓库创建一次初始提交（如勾选初始化 README）。');
    process.exit(1);
  }
  const branches = await api('GET', `/repos/${REPO}/branches`);
  const branch = (Array.isArray(branches) ? branches : []).find((item) => item.name === defaultBranch);
  const sha = branch?.commit?.sha;
  if (!sha) { console.error(`无法获取 ${defaultBranch} 分支提交`); process.exit(1); }
  return { defaultBranch, sha };
}

async function ensureTag(headSha) {
  const tags = await api('GET', `/repos/${REPO}/tags`);
  if ((Array.isArray(tags) ? tags : []).some((item) => item.name === TAG)) {
    console.log(`tag 已存在：${TAG}`);
    return;
  }
  await api('POST', `/repos/${REPO}/tags`, { json: { tag_name: TAG, refs: headSha } });
  console.log(`已创建 tag：${TAG}（指向 ${headSha.slice(0, 10)}）`);
}

async function removeExistingRelease() {
  const releases = await api('GET', `/repos/${REPO}/releases?per_page=100`);
  const existing = (Array.isArray(releases) ? releases : []).find((item) => item.tag_name === TAG);
  if (!existing?.id) return;
  await api('DELETE', `/repos/${REPO}/releases/${existing.id}`);
  console.log(`已删除同名旧 release：${TAG}`);
}

async function uploadAttachment(releaseId, filename) {
  const buffer = fs.readFileSync(path.join(ASSETS_DIR, filename));
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  const attached = await api('POST', `/repos/${REPO}/releases/${releaseId}/attach_files`, { form });
  return String(attached.browser_download_url ?? '');
}

async function main() {
  const { defaultBranch, sha: branchHeadSha } = await headSha();

  await ensureTag(branchHeadSha);
  await removeExistingRelease();

  const version = TAG.replace(/^v/, '');
  const releaseNotes = [
    `本版本安装包已通过自动构建、版本号检查和 SHA-256 校验。`,
    `同步自 GitHub Release：https://github.com/${GH_REPO}/releases/tag/${TAG}`,
  ].join('\n');
  const release = await api('POST', `/repos/${REPO}/releases`, {
    json: {
      tag_name: TAG,
      target_commitish: defaultBranch,
      name: `美美大王工作台 ${version}`,
      body: releaseNotes,
      prerelease: false,
    },
  });
  console.log(`已创建 Gitee release：${TAG}（id=${release.id}）`);

  const uploadNames = [...installers, 'SHA256SUMS.txt'];
  for (const name of uploadNames) {
    const url = await uploadAttachment(release.id, name);
    console.log(`已上传 ${name} → ${url}`);
  }

  const verify = await api('GET', `/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`);
  const assetByName = new Map(
    (verify.assets ?? []).map((item) => [String(item.name), String(item.browser_download_url ?? '')]),
  );
  for (const name of uploadNames) {
    if (!assetByName.has(name)) {
      console.error(`读回校验失败：附件 ${name} 未出现在 Gitee 发行版中`);
      process.exit(1);
    }
  }
  if (verify.assets.length > uploadNames.length + 2) {
    console.warn(`注意：Gitee 发行版中还有 ${verify.assets.length - uploadNames.length} 个归档/其他附件`);
  }

  const manifest = {
    tag_name: TAG,
    html_url: `https://gitee.com/${REPO}/releases/tag/${TAG}`,
    release_notes: releaseNotes,
    assets: uploadNames.map((name) => ({
      name,
      browser_download_url: assetByName.get(name),
      size: fs.statSync(path.join(ASSETS_DIR, name)).size,
      sha256: checksums.get(name) ?? '',
    })),
  };
  const manifestPath = path.join(ASSETS_DIR, 'update-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestUrl = await uploadAttachment(release.id, 'update-manifest.json');
  console.log(`已上传 update-manifest.json → ${manifestUrl}`);

  const final = await api('GET', `/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`);
  const finalNames = (final.assets ?? []).map((item) => String(item.name));
  for (const required of [...uploadNames, 'update-manifest.json']) {
    if (!finalNames.includes(required)) {
      console.error(`最终校验失败：缺少 ${required}`);
      process.exit(1);
    }
  }
  console.log(`Gitee 镜像完成：https://gitee.com/${REPO}/releases/tag/${TAG}`);
}

main().catch((error) => {
  console.error(`Gitee 镜像失败：${error.message}`);
  process.exit(1);
});
