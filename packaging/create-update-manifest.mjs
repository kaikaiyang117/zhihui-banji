#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const checksums = new Map();
for (const line of fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [digest, ...parts] = line.trim().split(/\s+/);
  checksums.set(path.basename(parts.join(' ').replace(/^\*/, '')), digest);
}

const assets = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && !['SHA256SUMS.txt', 'update-manifest.json'].includes(entry.name))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) => {
    const file = path.join(root, entry.name);
    return {
      name: entry.name,
      browser_download_url: `https://github.com/${process.env.REPOSITORY}/releases/download/${process.env.RELEASE_TAG}/${entry.name}`,
      size: fs.statSync(file).size,
      sha256: checksums.get(entry.name) ?? '',
    };
  });

fs.writeFileSync(path.join(root, 'update-manifest.json'), `${JSON.stringify({
  tag_name: process.env.RELEASE_TAG,
  html_url: `https://github.com/${process.env.REPOSITORY}/releases/tag/${process.env.RELEASE_TAG}`,
  assets,
}, null, 2)}\n`);
