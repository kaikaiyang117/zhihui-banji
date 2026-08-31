#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const repository = String(process.env.REPOSITORY ?? '').trim();
const releaseTag = String(process.env.RELEASE_TAG ?? '').trim();
const updateBaseUrl = String(process.env.UPDATE_BASE_URL ?? '').replace(/\/+$/, '');

if (!releaseTag) throw new Error('缺少 RELEASE_TAG');
if (!updateBaseUrl && !repository) throw new Error('缺少 REPOSITORY 或 UPDATE_BASE_URL');

const checksums = new Map();
for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [digest, ...parts] = line.trim().split(/\s+/);
  checksums.set(path.basename(parts.join(' ').replace(/^\*/, '')), digest);
}

const githubBase = repository ? `https://github.com/${repository}/releases/download/${releaseTag}` : '';
const configuredBases = [
  updateBaseUrl,
  ...(process.env.UPDATE_MIRROR_BASE_URLS || '').split(/[;,\n]/),
  githubBase,
].map((value) => String(value || '').trim().replace(/\/+$/, '')).filter(Boolean);

function assetUrls(filename) {
  const urls = [];
  for (const base of configuredBases) {
    const url = `${base}/${encodeURIComponent(filename)}`;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`只允许 HTTP/HTTPS URL：${url}`);
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
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
    const urls = assetUrls(entry.name);
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
  assets,
}, null, 2)}\n`);
