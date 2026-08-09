# -*- coding: utf-8 -*-
"""知识库 Markdown 文件与 SQLite 元数据索引。"""
from __future__ import annotations

from datetime import date, datetime
import hashlib
import json
import os
import re
import tempfile
import threading

from .. import clock, db
from .. import config
from . import audit, class_context


TEMPLATES = ['备课笔记', '考研知识点', '读书笔记', '学生档案', '班会记录', '班主任日志']
_write_lock = threading.RLock()


class KnowledgeError(ValueError):
    pass


class KnowledgeConflict(KnowledgeError):
    pass


def _kb_dir() -> str:
    return config.KB_DIR


TEMPLATE_BODY = {
    '备课笔记': '\n# 备课笔记\n\n## 课题\n\n## 教学目标\n\n- 知识目标：\n- 能力目标：\n- 情感目标：\n\n## 教学重难点\n\n**重点：**\n\n**难点：**\n\n## 教学过程\n\n### 导入\n\n### 新课讲授\n\n### 课堂小结\n\n### 作业布置\n\n## 教学反思\n\n',
    '考研知识点': '\n# 考研知识点\n\n## 所属科目\n\n## 知识点概述\n\n## 核心概念\n\n1. \n2. \n3. \n\n## 记忆口诀\n\n## 真题链接\n\n- [ ] 年份/题型：\n\n## 复习记录\n\n| 日期 | 掌握程度 | 备注 |\n|------|----------|------|\n| {today} | 初次学习 | |\n',
    '读书笔记': '\n# 读书笔记\n\n## 书籍信息\n\n- 书名：\n- 作者：\n- 阅读日期：{today}\n\n## 核心观点\n\n## 精彩摘录\n\n> \n\n## 我的思考\n\n## 行动清单\n\n- [ ] \n',
    '学生档案': '\n# 学生档案\n\n## 基本信息\n\n- 姓名：\n- 学号：\n- 家庭情况：\n\n## 学业表现\n\n## 行为记录\n\n| 日期 | 事件 | 处理 |\n|------|------|------|\n| {today} | | |\n\n## 重点关注\n\n',
    '班会记录': '\n# 班会记录\n\n- 日期：{today}\n- 主题：\n- 主持人：\n\n## 会议内容\n\n## 学生反馈\n\n## 后续跟进\n\n',
    '班主任日志': '\n# 班主任日志\n\n- 日期：{today}\n- 天气：\n\n## 今日记事\n\n## 好人好事\n\n## 存在问题\n\n## 明日计划\n\n',
}


def _text(value) -> str:
    return str(value or '').strip()


def _scope(*, write=False, conn=None):
    return class_context.scope_ids(write=write, conn=conn or db.get_conn())


def _safe_relative(relative_path: str) -> str:
    value = _text(relative_path).replace('\\', '/')
    if not value or value.startswith('/') or '\x00' in value:
        raise KnowledgeError('笔记路径不合法')
    normalized = os.path.normpath(value).replace('\\', '/')
    if normalized in {'.', '..'} or normalized.startswith('../') or '/..' in normalized:
        raise KnowledgeError('笔记路径不合法')
    if not normalized.lower().endswith('.md'):
        normalized += '.md'
    return normalized


def _full_path(relative_path: str) -> str:
    relative_path = _safe_relative(relative_path)
    root = os.path.abspath(_kb_dir())
    path = os.path.abspath(os.path.join(root, relative_path))
    if path != root and not path.startswith(root + os.sep):
        raise KnowledgeError('笔记路径不合法')
    return path


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


def _parse_tags(value: str) -> list[str]:
    text = _text(value)
    if text.startswith('[') and text.endswith(']'):
        text = text[1:-1]
    values = []
    for item in text.split(','):
        item = item.strip().strip('"\'')
        if item and item not in values:
            values.append(item[:40])
    return values[:30]


def _parse_frontmatter(content: str) -> tuple[dict, str]:
    metadata = {}
    body = content
    if content.startswith('---\n'):
        end = content.find('\n---', 4)
        if end >= 0:
            raw = content[4:end]
            body = content[end + 4:].lstrip('\n')
            for line in raw.splitlines():
                if ':' not in line:
                    continue
                key, value = line.split(':', 1)
                metadata[_text(key)] = _text(value)
    title = _text(metadata.get('title'))
    if not title:
        heading = re.search(r'^#\s+(.+?)\s*$', body, re.MULTILINE)
        title = _text(heading.group(1)) if heading else ''
    return {
        'title': title,
        'category': _text(metadata.get('category')) or '未分类',
        'tags': _parse_tags(metadata.get('tags', '')),
        'date': _text(metadata.get('date')),
    }, body


def _frontmatter(content: str, *, title: str, category: str, tags: list[str]) -> str:
    metadata, body = _parse_frontmatter(content)
    title = _text(title) or metadata.get('title') or '未命名笔记'
    category = _text(category) or metadata.get('category') or '未分类'
    tags = tags if tags is not None else metadata.get('tags', [])
    today = metadata.get('date') or clock.today().isoformat()
    return (
        '---\n'
        f'title: {title}\n'
        f'date: {today}\n'
        f'category: {category}\n'
        f'tags: [{", ".join(tags)}]\n'
        '---\n\n' + body.rstrip() + '\n'
    )


def _metadata_row(relative_path: str, *, conn=None):
    conn = conn or db.get_conn()
    return conn.execute('SELECT * FROM knowledge_notes WHERE relative_path=?', (relative_path,)).fetchone()


def _sync_file(relative_path: str, *, conn=None, accept_changes: bool = False) -> dict:
    conn = conn or db.get_conn()
    path = _full_path(relative_path)
    relative_path = _safe_relative(relative_path)
    if not os.path.isfile(path):
        raise KnowledgeError('笔记文件不存在')
    with open(path, encoding='utf-8') as source:
        content = source.read()
    metadata, _ = _parse_frontmatter(content)
    stat = os.stat(path)
    digest = _hash(content)
    row = _metadata_row(relative_path, conn=conn)
    status = '同步'
    if row and row['content_hash'] and row['content_hash'] != digest and not accept_changes:
        status = '文件已修改'
    if row and row['sync_status'] == '待恢复' and not accept_changes:
        status = '待恢复'
    class_id, term_id = _scope(conn=conn)
    stored_hash = digest if not row or accept_changes else row['content_hash']
    if row:
        conn.execute(
            '''UPDATE knowledge_notes SET title=?,category=?,tags=?,content_hash=?,file_mtime=?,sync_status=?,
               class_id=COALESCE(class_id,?),term_id=COALESCE(term_id,?),updated_at=? WHERE relative_path=?''',
            (metadata['title'] or os.path.splitext(os.path.basename(relative_path))[0], metadata['category'],
             json.dumps(metadata['tags'], ensure_ascii=False), stored_hash, stat.st_mtime, status,
             class_id, term_id, datetime.now().strftime('%Y-%m-%d %H:%M:%S'), relative_path),
        )
        note_id = int(row['id'])
    else:
        note_id = conn.execute(
            '''INSERT INTO knowledge_notes(class_id,term_id,relative_path,title,category,tags,content_hash,file_mtime,sync_status)
               VALUES(?,?,?,?,?,?,?,?,?)''',
            (class_id, term_id, relative_path,
             metadata['title'] or os.path.splitext(os.path.basename(relative_path))[0], metadata['category'],
             json.dumps(metadata['tags'], ensure_ascii=False), digest, stat.st_mtime, status),
        ).lastrowid
    return {
        'id': int(note_id), 'relative_path': relative_path,
        'title': metadata['title'] or os.path.splitext(os.path.basename(relative_path))[0],
        'category': metadata['category'], 'tags': metadata['tags'], 'content_hash': stored_hash,
        'current_hash': digest, 'file_mtime': stat.st_mtime, 'sync_status': status,
    }


def _decorate(note: dict, *, conn=None) -> dict:
    conn = conn or db.get_conn()
    item = dict(note)
    try:
        item['tags'] = json.loads(item.get('tags') or '[]')
    except (TypeError, ValueError):
        item['tags'] = _parse_tags(item.get('tags', ''))
    item['links'] = [dict(row) for row in conn.execute(
        'SELECT * FROM knowledge_note_links WHERE note_id=? ORDER BY id', (item['id'],)
    ).fetchall()]
    return item


def list_notes(*, query: str = '', tag: str = '', category: str = '', conn=None) -> dict:
    conn = conn or db.get_conn()
    os.makedirs(_kb_dir(), exist_ok=True)
    files = []
    for root, dirs, names in os.walk(_kb_dir()):
        dirs[:] = [name for name in dirs if name not in {'.git', '__pycache__'}]
        for name in names:
            if name.lower().endswith('.md'):
                files.append(os.path.relpath(os.path.join(root, name), _kb_dir()).replace(os.sep, '/'))
    indexed = []
    for relative_path in files:
        try:
            indexed.append(_sync_file(relative_path, conn=conn))
        except (OSError, KnowledgeError):
            continue
    conn.commit()
    q = _text(query).lower()
    wanted_tag = _text(tag).lower()
    wanted_category = _text(category)
    result = []
    for item in indexed:
        if wanted_category and item['category'] != wanted_category:
            continue
        if wanted_tag and wanted_tag not in {x.lower() for x in item['tags']}:
            continue
        if q:
            path = _full_path(item['relative_path'])
            try:
                with open(path, encoding='utf-8') as source:
                    haystack = source.read().lower()
            except OSError:
                haystack = ''
            if q not in (item['title'] + ' ' + item['relative_path']).lower() and q not in haystack:
                continue
        result.append(_decorate(item, conn=conn))
    result.sort(key=lambda item: item['file_mtime'], reverse=True)
    categories = sorted({item['category'] for item in indexed})
    tags = sorted({tag for item in indexed for tag in item['tags']})
    return {'notes': result, 'categories': categories, 'tags': tags, 'templates': TEMPLATES}


def read_note(relative_path: str, *, conn=None) -> dict:
    conn = conn or db.get_conn()
    item = _sync_file(relative_path, conn=conn)
    path = _full_path(relative_path)
    with open(path, encoding='utf-8') as source:
        content = source.read()
    conn.commit()
    return {**_decorate(item, conn=conn), 'content': content, 'recoverable': item['sync_status'] in {'文件已修改', '待恢复'}}


def create_note(*, title: str, category: str = '个人成长', template: str = '', content: str = '',
                tags=None, links=None, conn=None) -> dict:
    conn = conn or db.get_conn()
    title, category = _text(title), _text(category) or '个人成长'
    if not title:
        raise KnowledgeError('请输入笔记标题')
    safe_title = re.sub(r'[\\/:*?"<>|]+', '-', title).strip('-') or '未命名笔记'
    relative_path = _safe_relative(f'{category}/{safe_title}.md')
    path = _full_path(relative_path)
    if os.path.exists(path):
        raise KnowledgeError(f'笔记“{title}”已存在')
    body = TEMPLATE_BODY.get(_text(template), '').format(today=clock.today().isoformat()) if template else _text(content)
    if template and content:
        body += '\n' + _text(content)
    full = _frontmatter(body, title=title, category=category, tags=list(tags or []))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'x', encoding='utf-8') as target:
        target.write(full)
    item = _sync_file(relative_path, conn=conn)
    _replace_links(item['id'], links or [], conn=conn)
    audit.record('knowledge_note', item['id'], 'create', summary=f'新建知识库笔记：{title}',
                 params={'relative_path': relative_path, 'tag_count': len(tags or [])}, conn=conn)
    return read_note(relative_path, conn=conn)


def update_note(note_id: int, *, content: str, expected_hash: str = '', force: bool = False,
                title: str = '', category: str = '', tags=None, links=None, conn=None) -> dict:
    conn = conn or db.get_conn()
    row = conn.execute('SELECT * FROM knowledge_notes WHERE id=?', (int(note_id),)).fetchone()
    if not row:
        raise KnowledgeError('笔记不存在')
    relative_path = row['relative_path']
    path = _full_path(relative_path)
    if not os.path.isfile(path):
        raise KnowledgeError('笔记文件不存在，无法保存')
    with open(path, encoding='utf-8') as source:
        current = source.read()
    current_hash = _hash(current)
    if expected_hash and current_hash != expected_hash and not force:
        conn.execute("UPDATE knowledge_notes SET sync_status='文件已修改' WHERE id=?", (note_id,))
        conn.commit()
        raise KnowledgeConflict('文件已被外部修改，请重新读取后再保存；原文件仍保留')
    full = _frontmatter(content, title=title or row['title'], category=category or row['category'],
                        tags=list(tags) if tags is not None else None)
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(prefix='.workbench-', suffix='.md', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            target.write(full)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
    item = _sync_file(relative_path, conn=conn, accept_changes=True)
    _replace_links(item['id'], links or [], conn=conn)
    audit.record('knowledge_note', note_id, 'update', summary=f'更新知识库笔记：{item["title"]}',
                 params={'relative_path': relative_path, 'force': bool(force)}, conn=conn)
    return read_note(relative_path, conn=conn)


def adopt_external_change(note_id: int, *, conn=None) -> dict:
    conn = conn or db.get_conn()
    row = conn.execute('SELECT relative_path FROM knowledge_notes WHERE id=?', (int(note_id),)).fetchone()
    if not row:
        raise KnowledgeError('笔记不存在')
    item = _sync_file(row['relative_path'], conn=conn, accept_changes=True)
    conn.execute("UPDATE knowledge_notes SET sync_status='同步' WHERE id=?", (note_id,))
    audit.record('knowledge_note', note_id, 'adopt_external', summary='采纳外部修改的知识库笔记', conn=conn)
    return read_note(row['relative_path'], conn=conn)


def _replace_links(note_id: int, links, *, conn=None):
    conn = conn or db.get_conn()
    class_id, term_id = _scope(write=True, conn=conn)
    conn.execute('DELETE FROM knowledge_note_links WHERE note_id=?', (note_id,))
    for link in links:
        link_type = _text(link.get('link_type') or link.get('type'))
        link_id = link.get('link_id', link.get('id'))
        if link_type not in {'meeting', 'activity', 'diary', 'work_item'}:
            raise KnowledgeError('知识库关联类型不合法')
        try:
            link_id = int(link_id)
        except (TypeError, ValueError) as exc:
            raise KnowledgeError('知识库关联 ID 不合法') from exc
        table = {'meeting': 'meeting_records', 'activity': 'activity_records',
                 'diary': 'diary_entries', 'work_item': 'student_tasks'}[link_type]
        if not conn.execute(
            f"SELECT 1 FROM {table} WHERE id=? AND class_id=? AND term_id=? "
            + ("AND deleted_at=''" if table != 'student_tasks' else "AND deleted_at=''"),
            (link_id, class_id, term_id)).fetchone():
            raise KnowledgeError('关联的来源记录不存在')
        conn.execute(
            'INSERT OR IGNORE INTO knowledge_note_links(note_id,link_type,link_id,label) VALUES(?,?,?,?)',
            (note_id, link_type, link_id, _text(link.get('label'))),
        )


def evaluate_startup(*, conn=None):
    os.makedirs(_kb_dir(), exist_ok=True)
