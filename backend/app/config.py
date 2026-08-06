# -*- coding: utf-8 -*-
"""美美大王工作台 - 配置

开发模式使用项目目录；桌面打包模式把可变数据放到系统用户数据目录，
把前端静态资源留在程序资源目录中，避免升级程序覆盖用户数据。
"""
import os
import sys


APP_NAME = 'MeimeiWorkbench'
IS_FROZEN = bool(getattr(sys, 'frozen', False))

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
ROOT_DIR = os.path.dirname(BASE_DIR)                                    # 项目根目录


def _default_data_dir() -> str:
    configured = os.environ.get('WORKBENCH_DATA_DIR')
    if configured:
        return os.path.abspath(configured)
    if not IS_FROZEN:
        return os.path.join(ROOT_DIR, 'data')
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA') or os.path.expanduser('~')
    elif sys.platform == 'darwin':
        base = os.path.join(os.path.expanduser('~'), 'Library', 'Application Support')
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, APP_NAME)


RESOURCE_ROOT = getattr(sys, '_MEIPASS', ROOT_DIR)
DATA_DIR = _default_data_dir()
DB_PATH = os.path.join(DATA_DIR, 'workbench.db')
_default_kb_dir = os.path.join(DATA_DIR, '知识库') if IS_FROZEN else os.path.join(ROOT_DIR, '知识库')
KB_DIR = os.environ.get('WORKBENCH_KB_DIR', _default_kb_dir)
KB_DIR = os.path.abspath(KB_DIR)
LEGACY_BZR = os.path.join(RESOURCE_ROOT, '班主任工作台', '班主任工作台.xlsx')
LEGACY_HEALTH = os.path.join(RESOURCE_ROOT, '健康管理', '健康追踪表.xlsx')
STATIC_DIR = os.path.join(RESOURCE_ROOT, 'backend', 'static') if IS_FROZEN else os.path.join(BASE_DIR, 'static')

# 学生信息默认只在本机提供；确需局域网访问时显式设置 WORKBENCH_HOST。
HOST = os.environ.get('WORKBENCH_HOST', '127.0.0.1')
PORT = int(os.environ.get('WORKBENCH_PORT', '5000'))

# 工作表 → 模块归属（前端分组）
SHEET_META = {
    # 学生管理
    '学生信息总表': {'category': '学生管理', 'group': 'teacher'},
    '特殊学生档案': {'category': '学生管理', 'group': 'teacher'},
    '评语管理': {'category': '学生管理', 'group': 'teacher'},
    # 教学管理
    '考勤管理': {'category': '教学管理', 'group': 'teacher'},
    '成绩跟踪': {'category': '教学管理', 'group': 'teacher'},
    '日常行为积分': {'category': '教学管理', 'group': 'teacher'},
    # 班级事务
    '座位表': {'category': '班级事务', 'group': 'teacher'},
    '家校沟通记录': {'category': '班级事务', 'group': 'teacher'},
    '谈心记录': {'category': '班级事务', 'group': 'teacher'},
    '班会记录': {'category': '班级事务', 'group': 'teacher'},
    '班费管理': {'category': '班级事务', 'group': 'teacher'},
    '班委管理': {'category': '班级事务', 'group': 'teacher'},
    '班级活动': {'category': '班级事务', 'group': 'teacher'},
    # 日志
    '班主任日志': {'category': '日志', 'group': 'teacher'},
    '工作计划总结': {'category': '日志', 'group': 'teacher'},
    # 健康
    '体重体脂追踪': {'category': '健康管理', 'group': 'personal'},
    '运动记录': {'category': '健康管理', 'group': 'personal'},
    '睡眠记录': {'category': '健康管理', 'group': 'personal'},
    '饮食记录': {'category': '健康管理', 'group': 'personal'},
    '月度总结': {'category': '健康管理', 'group': 'personal'},
}

STUDENT_COLUMNS = ['学号', '姓名', '性别', '出生年月', '民族', '家庭住址', '监护人姓名',
                   '监护人电话', '监护人职业', '是否住校', '特长', '班级任职', '备注',
                   '监护人2姓名', '监护人2电话', '监护人2关系']
