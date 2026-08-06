#!/usr/bin/env python3
"""Create the release manifest used when GitHub API rate limits are reached."""
import json
import os
from pathlib import Path


root = Path.cwd()
checksum_lines = {}
for line in (root / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
    digest, name = line.split(maxsplit=1)
    checksum_lines[Path(name.lstrip('*')).name] = digest

assets = []
for path in sorted(root.iterdir()):
    if path.name in {'SHA256SUMS.txt', 'update-manifest.json'} or not path.is_file():
        continue
    assets.append({
        'name': path.name,
        'browser_download_url': (
            f"https://github.com/{os.environ['REPOSITORY']}/releases/download/"
            f"{os.environ['RELEASE_TAG']}/{path.name}"
        ),
        'size': path.stat().st_size,
        'sha256': checksum_lines[path.name],
    })

(root / 'update-manifest.json').write_text(json.dumps({
    'tag_name': os.environ['RELEASE_TAG'],
    'html_url': (
        f"https://github.com/{os.environ['REPOSITORY']}/releases/tag/"
        f"{os.environ['RELEASE_TAG']}"
    ),
    'assets': assets,
}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
