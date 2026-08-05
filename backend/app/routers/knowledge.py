# -*- coding: utf-8 -*-
"""知识库路由（Markdown 笔记管理，Obsidian 集成）"""
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException

from ..config import KB_DIR

router = APIRouter(prefix='/api/knowledge')

TEMPLATES = ['备课笔记', '考研知识点', '读书笔记', '学生档案', '班会记录', '班主任日志']

TEMPLATE_BODY = {
    '备课笔记': '\n# 备课笔记\n\n## 课题\n\n## 教学目标\n\n- 知识目标：\n- 能力目标：\n- 情感目标：\n\n## 教学重难点\n\n**重点：**\n\n**难点：**\n\n## 教学过程\n\n### 导入\n\n### 新课讲授\n\n### 课堂小结\n\n### 作业布置\n\n## 教学反思\n\n',
    '考研知识点': '\n# 考研知识点\n\n## 所属科目\n\n## 知识点概述\n\n## 核心概念\n\n1. \n2. \n3. \n\n## 记忆口诀\n\n## 真题链接\n\n- [ ] 年份/题型：\n\n## 复习记录\n\n| 日期 | 掌握程度 | 备注 |\n|------|----------|------|\n| {today} | 初次学习 | |\n',
    '读书笔记': '\n# 读书笔记\n\n## 书籍信息\n\n- 书名：\n- 作者：\n- 阅读日期：{today}\n\n## 核心观点\n\n## 精彩摘录\n\n> \n\n## 我的思考\n\n## 行动清单\n\n- [ ] \n',
    '学生档案': '\n# 学生档案\n\n## 基本信息\n\n- 姓名：\n- 学号：\n- 家庭情况：\n\n## 学业表现\n\n## 行为记录\n\n| 日期 | 事件 | 处理 |\n|------|------|------|\n| {today} | | |\n\n## 重点关注\n\n',
    '班会记录': '\n# 班会记录\n\n- 日期：{today}\n- 主题：\n- 主持人：\n\n## 会议内容\n\n## 学生反馈\n\n## 后续跟进\n\n',
    '班主任日志': '\n# 班主任日志\n\n- 日期：{today}\n- 天气：\n\n## 今日记事\n\n## 好人好事\n\n## 存在问题\n\n## 明日计划\n\n',
}


@router.get('/notes')
def list_notes():
    notes = []
    if not os.path.exists(KB_DIR):
        return {'notes': [], 'categories': []}
    for root, dirs, files in os.walk(KB_DIR):
        for f in files:
            if f.endswith('.md'):
                full = os.path.join(root, f)
                rel = os.path.relpath(full, KB_DIR)
                parts = rel.replace('\\', '/').split('/')
                category = parts[0] if len(parts) > 1 else '未分类'
                stat = os.stat(full)
                notes.append({
                    'name': os.path.splitext(parts[-1])[0],
                    'category': category,
                    'relative_path': rel,
                    'size': stat.st_size,
                    'modified': stat.st_mtime,
                })
    categories = [d for d in os.listdir(KB_DIR)
                  if os.path.isdir(os.path.join(KB_DIR, d))]
    notes.sort(key=lambda x: x['modified'], reverse=True)
    return {'notes': notes, 'categories': categories}


@router.post('/create')
def create_note(payload: dict):
    title = str(payload.get('title', '')).strip()
    category = str(payload.get('category', '个人成长')).strip()
    template = str(payload.get('template', '')).strip()
    content = str(payload.get('content', ''))
    if not title:
        raise HTTPException(400, '请输入笔记标题')

    category_dir = os.path.join(KB_DIR, category)
    os.makedirs(category_dir, exist_ok=True)
    safe = title.replace('/', '-').replace('\\', '-')
    filepath = os.path.join(category_dir, f'{safe}.md')
    if os.path.exists(filepath):
        raise HTTPException(409, f'笔记 "{title}" 已存在')

    today = datetime.now().strftime('%Y-%m-%d')
    full = (f'---\ntitle: {title}\ndate: {today}\ncategory: {category}\ntags: []\n---\n\n')
    if template in TEMPLATE_BODY:
        full += TEMPLATE_BODY[template].format(today=today)
    full += content
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(full)
    return {'ok': True, 'title': title}