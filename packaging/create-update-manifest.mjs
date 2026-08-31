#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const repository = String(process.env.REPOSITORY ?? '').trim();
const releaseTag = String(process.env.RELEASE_TAG ?? '').trim();
const updateBaseUrl = String(process.env.UPDATE_BASE_URL ?? '').replace(/\/+$/, '');
const mirrorBaseUrls = String(process.env.UPDATE_MIRROR_BASE_URLS ?? '')
  .split(/[;,\n]/)
  .map(value => value.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (!releaseTag) throw new Error('缺少 RELEASE_TAG');
if (!updateBaseUrl && !repository) throw new Error('缺少 REPOSITORY 或 UPDATE_BASE_URL');

const checksums = new Map();
for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [digest, ...parts] = line.trim().split(/\s+/);
  checksums.set(path.basename(parts.join(' ').replace(/^\*/, '')), digest);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function fileUrl(base, filename) {
  return `${base}/${encodeURIComponent(filename)}`;
}

const assets = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !['SHA256SUMS.txt', 'update-manifest.json'].includes(entry.name))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) => {
    const file = path.join(root, entry.name);
    const checksum = checksums.get(entry.name) ?? '';
    if (!/^[a-f0-9]{64}$/i.test(checksum)) {
      throw new Error(`缺少有效 SHA-256：${entry.name}`);
    }
    const primaryUrl = updateBaseUrl
      ? fileUrl(updateBaseUrl, entry.name)
      : `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(entry.name)}`;
    const githubUrl = repository
      ? `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(entry.name)}`
      : '';
    const urls = unique([
      primaryUrl,
      ...mirrorBaseUrls.map(base => fileUrl(base, entry.name)),
      githubUrl,
    ]);
    return {
      name: entry.name,
      browser_download_url: urls[0],
      urls,
      size: fs.statSync(file).size,
      sha256: checksum,
    };
  });

fs.writeFileSync(path.join(root, 'update-manifest.json'), `${JSON.stringify({
  tag_name: releaseTag,
  html_url: process.env.RELEASE_URL
    ?? (repository ? `https://github.com/${repository}/releases/tag/${releaseTag}` : updateBaseUrl),
  release_notes: String(process.env.RELEASE_NOTES ?? ''),
  assets,
}, null, 2)}\n`);
