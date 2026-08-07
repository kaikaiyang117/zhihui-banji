# -*- coding: utf-8 -*-
"""测试数据辅助函数。"""
from app import db
from app.services.class_context import scope_ids


def enroll_all_students():
    conn = db.get_conn()
    class_id, term_id = scope_ids(conn=conn)
    conn.execute(
        '''INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status, joined_at)
           SELECT id, ?, ?, '在读', date('now','localtime') FROM students''',
        (class_id, term_id),
    )
    conn.commit()
