/* MIG-03 迁移引擎：维护当前 SQLite 基础 schema 与全部历史迁移（v1→v34）。
 *
 * 迁移纪律：
 * - 仅仅翻译不增加 schema 版本；Node 新增表/列时才创建下一版本并同步 Python 策略。
 * - 迁移 SQL 与 Python 实现逐条核对（IF NOT EXISTS、ON CONFLICT、索引、外键一致）。
 * - 版本标记只在迁移成功后写入；失败后重启从已记录版本继续（与 Python 行为一致）。
 */
import type { Database } from 'better-sqlite3';

export const BASE_SCHEMA_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 34;

/** 与 Python _add_column 一致：按 PRAGMA table_info 判断并补列。 */
export function addColumn(conn: Database, table: string, column: string, definition: string): void {
  const columns = new Set<string>();
  for (const row of conn.pragma(`table_info(${table})`) as Array<{ name: string }>) {
    columns.add(row.name);
  }
  if (!columns.has(column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ---------- 迁移 2-28 ----------

function migration2(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS student_import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL DEFAULT '',
        imported INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
}

function migration3(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS agent_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL DEFAULT 'local',
        actor_id TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        result_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
}

function migration4(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS wechat_message_receipts (
        message_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'processing',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
}

function migration5(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        grade TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '使用中',
        archived_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        start_date TEXT NOT NULL DEFAULT '',
        end_date TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '进行中',
        archived_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, name)
    );

    CREATE TABLE IF NOT EXISTS student_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT '在读',
        joined_at TEXT NOT NULL DEFAULT '',
        left_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(student_id, class_id, term_id)
    );

    INSERT INTO classes(name, grade, status)
    SELECT '我的班级', '', '使用中'
    WHERE NOT EXISTS (SELECT 1 FROM classes);
  `);
  const classRow = conn.prepare('SELECT id FROM classes ORDER BY id LIMIT 1').get() as { id: number };
  conn.prepare(
    "INSERT INTO terms(class_id, name, status) SELECT ?, '当前学期', '进行中' "
    + 'WHERE NOT EXISTS (SELECT 1 FROM terms WHERE class_id=?)',
  ).run(classRow.id, classRow.id);
  const termRow = conn.prepare(
    'SELECT id FROM terms WHERE class_id=? ORDER BY id LIMIT 1',
  ).get(classRow.id) as { id: number };

  const scopedTables = [
    'student_events', 'student_tasks', 'focus_items', 'communications',
    'attendance_rules', 'class_tasks', 'sheet_rows', 'student_import_runs',
  ];
  for (const table of scopedTables) {
    addColumn(conn, table, 'class_id', 'INTEGER REFERENCES classes(id)');
    addColumn(conn, table, 'term_id', 'INTEGER REFERENCES terms(id)');
    conn.exec(
      `UPDATE ${table} SET class_id=COALESCE(class_id, ${classRow.id}), term_id=COALESCE(term_id, ${termRow.id})`,
    );
  }

  conn.exec(
    "INSERT OR IGNORE INTO student_enrollments(student_id, class_id, term_id, status) "
    + `SELECT id, ${classRow.id}, ${termRow.id}, '在读' FROM students`,
  );

  conn.exec(`
    DROP TABLE IF EXISTS exam_records_scoped;
    CREATE TABLE exam_records_scoped (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        exam_name TEXT NOT NULL,
        exam_date TEXT DEFAULT '',
        subject TEXT NOT NULL,
        score REAL,
        rank INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(student_id, class_id, term_id, exam_name, subject)
    );
    INSERT INTO exam_records_scoped
        (id, student_id, class_id, term_id, exam_name, exam_date, subject, score, rank, created_at, updated_at)
    SELECT id, student_id, ${classRow.id}, ${termRow.id}, exam_name, exam_date, subject, score, rank, created_at, updated_at
    FROM exam_records;
    DROP TABLE exam_records;
    ALTER TABLE exam_records_scoped RENAME TO exam_records;

    DROP TABLE IF EXISTS duty_assignments_scoped;
    CREATE TABLE duty_assignments_scoped (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        duty_date TEXT NOT NULL,
        area TEXT NOT NULL,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        status TEXT NOT NULL DEFAULT '待完成',
        note TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, duty_date, area, student_id)
    );
    INSERT INTO duty_assignments_scoped
        (id, duty_date, area, student_id, class_id, term_id, status, note, created_at, updated_at)
    SELECT id, duty_date, area, student_id, ${classRow.id}, ${termRow.id}, status, note, created_at, updated_at
    FROM duty_assignments;
    DROP TABLE duty_assignments;
    ALTER TABLE duty_assignments_scoped RENAME TO duty_assignments;

    DROP TABLE IF EXISTS seating_scoped;
    CREATE TABLE seating_scoped (
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        r INTEGER NOT NULL,
        c INTEGER NOT NULL,
        val TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (class_id, term_id, r, c)
    );
    INSERT INTO seating_scoped(class_id, term_id, r, c, val)
    SELECT ${classRow.id}, ${termRow.id}, r, c, val FROM seating;
    DROP TABLE seating;
    ALTER TABLE seating_scoped RENAME TO seating;

    CREATE INDEX IF NOT EXISTS idx_enrollments_scope
        ON student_enrollments(class_id, term_id, status, student_id);
    CREATE INDEX IF NOT EXISTS idx_events_scope ON student_events(class_id, term_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_scope ON student_tasks(class_id, term_id, status);
    CREATE INDEX IF NOT EXISTS idx_focus_scope ON focus_items(class_id, term_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_communications_scope ON communications(class_id, term_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_exams_scope ON exam_records(class_id, term_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_sheet_rows_scope ON sheet_rows(class_id, term_id, sheet);
    CREATE INDEX IF NOT EXISTS idx_class_tasks_scope ON class_tasks(class_id, term_id, status);
    CREATE INDEX IF NOT EXISTS idx_duty_scope ON duty_assignments(class_id, term_id, duty_date);
  `);
}

function migration6(conn: Database): void {
  const columns: Array<[string, string]> = [
    ['source_type', "TEXT NOT NULL DEFAULT 'manual'"],
    ['source_id', 'INTEGER'],
    ['source_key', "TEXT NOT NULL DEFAULT ''"],
    ['owner', "TEXT NOT NULL DEFAULT '班主任'"],
    ['scheduled_at', "TEXT NOT NULL DEFAULT ''"],
    ['result', "TEXT NOT NULL DEFAULT ''"],
    ['cancelled_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [column, definition] of columns) {
    addColumn(conn, 'student_tasks', column, definition);
  }
  conn.exec(`
    UPDATE student_tasks SET source_type=CASE source
        WHEN '学生事件' THEN 'event'
        WHEN '家校沟通' THEN 'communication'
        WHEN '关注事项' THEN 'focus'
        WHEN '考勤规则' THEN 'attendance_rule'
        WHEN '班级任务' THEN 'class_task'
        WHEN '值日安排' THEN 'duty_assignment'
        ELSE 'manual' END;

    UPDATE student_tasks
    SET source_id=event_id,
        source_key='event:' || event_id
    WHERE event_id IS NOT NULL
      AND id=(SELECT MIN(t2.id) FROM student_tasks t2 WHERE t2.event_id=student_tasks.event_id);

    UPDATE student_tasks
    SET source_id=(
            SELECT c.id FROM communications c
            WHERE c.student_id=student_tasks.student_id
              AND c.class_id=student_tasks.class_id
              AND c.term_id=student_tasks.term_id
              AND c.followup_at=student_tasks.due_at
            ORDER BY c.id LIMIT 1
        )
    WHERE source_type='communication' AND source_id IS NULL;

    UPDATE student_tasks
    SET source_key='communication:' || source_id
    WHERE source_type='communication' AND source_id IS NOT NULL
      AND id=(SELECT MIN(t2.id) FROM student_tasks t2
              WHERE t2.source_type='communication' AND t2.source_id=student_tasks.source_id);

    INSERT INTO student_tasks(
        student_id, title, source, source_type, source_id, source_key,
        due_at, priority, status, notes, class_id, term_id
    )
    SELECT f.student_id, f.topic || ' · 复查', '关注事项', 'focus', f.id,
           'focus:' || f.id, f.next_review_at, '重要', '待复查',
           COALESCE(NULLIF(f.action_plan, ''), f.reason), f.class_id, f.term_id
    FROM focus_items f
    WHERE f.next_review_at<>'' AND f.status<>'已结束'
      AND NOT EXISTS (
          SELECT 1 FROM student_tasks t
          WHERE t.class_id=f.class_id AND t.term_id=f.term_id
            AND t.source_type='focus' AND t.source_id=f.id
      );

    INSERT INTO student_tasks(
        student_id, title, source, source_type, source_id, source_key,
        due_at, priority, status, notes, class_id, term_id
    )
    SELECT c.student_id, '家校沟通回访', '家校沟通', 'communication', c.id,
           'communication:' || c.id, c.followup_at, '重要', '待复查',
           COALESCE(NULLIF(c.agreement, ''), c.summary), c.class_id, c.term_id
    FROM communications c
    WHERE c.followup_at<>'' AND c.status NOT IN ('已完成','已取消')
      AND NOT EXISTS (
          SELECT 1 FROM student_tasks t
          WHERE t.class_id=c.class_id AND t.term_id=c.term_id
            AND t.source_type='communication' AND t.source_id=c.id
      );

    INSERT INTO student_tasks(
        title, source, source_type, source_id, source_key,
        scheduled_at, due_at, priority, status, notes, class_id, term_id
    )
    SELECT ct.title, '班级任务', 'class_task', ct.id, 'class_task:' || ct.id,
           ct.start_at, ct.due_at, '普通', '待处理', ct.description,
           ct.class_id, ct.term_id
    FROM class_tasks ct
    WHERE ct.status NOT IN ('已完成','已取消')
      AND NOT EXISTS (
          SELECT 1 FROM student_tasks t
          WHERE t.class_id=ct.class_id AND t.term_id=ct.term_id
            AND t.source_type='class_task' AND t.source_id=ct.id
      );

    INSERT INTO student_tasks(
        student_id, title, source, source_type, source_id, source_key,
        scheduled_at, due_at, priority, status, notes, class_id, term_id
    )
    SELECT d.student_id, '值日 · ' || d.area, '值日安排', 'duty_assignment', d.id,
           'duty_assignment:' || d.id, d.duty_date, d.duty_date, '普通', '待处理',
           d.note, d.class_id, d.term_id
    FROM duty_assignments d
    WHERE d.status<>'已完成'
      AND NOT EXISTS (
          SELECT 1 FROM student_tasks t
          WHERE t.class_id=d.class_id AND t.term_id=d.term_id
            AND t.source_type='duty_assignment' AND t.source_id=d.id
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key
        ON student_tasks(class_id, term_id, source_key) WHERE source_key<>'';
    CREATE INDEX IF NOT EXISTS idx_tasks_due
        ON student_tasks(class_id, term_id, status, due_at, scheduled_at);
  `);
}

function migration7(conn: Database): void {
  addColumn(conn, 'student_events', 'result', "TEXT NOT NULL DEFAULT ''");
  addColumn(conn, 'student_events', 'closed_at', "TEXT NOT NULL DEFAULT ''");
  addColumn(conn, 'communications', 'result', "TEXT NOT NULL DEFAULT ''");
  addColumn(conn, 'communications', 'closed_at', "TEXT NOT NULL DEFAULT ''");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS workflow_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        action TEXT NOT NULL DEFAULT 'progress',
        content TEXT NOT NULL DEFAULT '',
        status_from TEXT NOT NULL DEFAULT '',
        status_to TEXT NOT NULL DEFAULT '',
        next_action_at TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    UPDATE communications SET status='待回访'
    WHERE followup_at<>'' AND status IN ('待跟进','待回访','进行中');

    CREATE INDEX IF NOT EXISTS idx_workflow_updates_source
        ON workflow_updates(class_id, term_id, source_type, source_id, id);
    CREATE INDEX IF NOT EXISTS idx_workflow_updates_student
        ON workflow_updates(class_id, term_id, student_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_updates_idempotency
        ON workflow_updates(class_id, term_id, idempotency_key)
        WHERE idempotency_key<>'';
  `);
}

function migration8(conn: Database): void {
  const tables = [
    'students', 'student_events', 'student_tasks', 'focus_items', 'communications',
    'exam_records', 'attendance_rules', 'class_tasks', 'duty_assignments', 'sheet_rows',
  ];
  for (const table of tables) {
    addColumn(conn, table, 'deleted_at', "TEXT NOT NULL DEFAULT ''");
    addColumn(conn, table, 'deleted_by', "TEXT NOT NULL DEFAULT ''");
  }
  conn.exec(`
    CREATE TABLE IF NOT EXISTS recycle_bin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        class_id INTEGER,
        term_id INTEGER,
        label TEXT NOT NULL DEFAULT '',
        snapshot TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT '已删除',
        deleted_by TEXT NOT NULL DEFAULT '',
        deleted_at TEXT DEFAULT (datetime('now','localtime')),
        restored_at TEXT NOT NULL DEFAULT '',
        purged_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS system_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL DEFAULT 'web',
        actor_id TEXT NOT NULL DEFAULT 'local-user',
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'success',
        summary TEXT NOT NULL DEFAULT '',
        params_summary TEXT NOT NULL DEFAULT '{}',
        class_id INTEGER,
        term_id INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_recycle_scope
        ON recycle_bin(class_id, term_id, status, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_system_audit_scope
        ON system_audit(class_id, term_id, created_at);
  `);
}

function migration9(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS pairing_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT '待使用',
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        used_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS paired_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '移动设备',
        credential_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT '已授权',
        paired_at TEXT DEFAULT (datetime('now','localtime')),
        last_seen_at TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT '',
        last_ip TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_pairing_status
        ON pairing_sessions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_paired_devices_status
        ON paired_devices(status, expires_at, last_seen_at);
  `);
}

function migration10(conn: Database): void {
  addColumn(conn, 'attendance_rules', 'scene', "TEXT NOT NULL DEFAULT '全部场景'");
  addColumn(conn, 'attendance_rules', 'last_run_at', "TEXT NOT NULL DEFAULT ''");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        attendance_date TEXT NOT NULL,
        scene TEXT NOT NULL DEFAULT '常规到校',
        status TEXT NOT NULL DEFAULT '出勤',
        arrive_at TEXT NOT NULL DEFAULT '',
        leave_at TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        legacy_row_no INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        UNIQUE(class_id, term_id, attendance_date, scene, student_id)
    );

    CREATE TABLE IF NOT EXISTS attendance_rule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        reference_date TEXT NOT NULL,
        rules_evaluated INTEGER NOT NULL DEFAULT 0,
        students_evaluated INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_count INTEGER NOT NULL DEFAULT 0,
        reopened_count INTEGER NOT NULL DEFAULT 0,
        resolved_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'success',
        error TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS attendance_rule_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES attendance_rules(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        status TEXT NOT NULL DEFAULT '待处理',
        current_value INTEGER NOT NULL DEFAULT 0,
        task_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
        first_hit_at TEXT NOT NULL DEFAULT '',
        last_hit_at TEXT NOT NULL DEFAULT '',
        handled_at TEXT NOT NULL DEFAULT '',
        resolved_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, rule_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_scope_date
        ON attendance_records(class_id, term_id, attendance_date, scene, student_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_student
        ON attendance_records(class_id, term_id, student_id, attendance_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_rule_runs
        ON attendance_rule_runs(class_id, term_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_attendance_rule_hits
        ON attendance_rule_hits(class_id, term_id, rule_id, status, student_id);
  `);

  let migrated = 0;
  let skipped = 0;
  const rows = conn.prepare(
    "SELECT row_no, data, class_id, term_id FROM sheet_rows "
    + "WHERE sheet='考勤管理' AND deleted_at='' ORDER BY row_no",
  ).all() as Array<{ row_no: number; data: string; class_id: number; term_id: number }>;
  const timePattern = /^\d{1,2}:\d{2}$/;
  const studentStmt = conn.prepare(`
    SELECT s.id FROM students s
    JOIN student_enrollments e ON e.student_id=s.id
    WHERE e.class_id=? AND e.term_id=?
      AND ((?<>'' AND s.学号=?) OR (?='' AND ?<>'' AND s.姓名=?))
    ORDER BY CASE WHEN s.学号=? THEN 0 ELSE 1 END, s.id LIMIT 1
  `);
  const insertStmt = conn.prepare(`
    INSERT INTO attendance_records(
        student_id, class_id, term_id, attendance_date, scene, status,
        arrive_at, leave_at, reason, note, legacy_row_no
    ) VALUES(?,?,?,?,'常规到校',?,?,?,?,?,?)
    ON CONFLICT(class_id, term_id, attendance_date, scene, student_id)
    DO NOTHING
  `);
  for (const row of rows) {
    let data: unknown[];
    try {
      data = JSON.parse(row.data) as unknown[];
    } catch {
      skipped += 1;
      continue;
    }
    if (!Array.isArray(data) || data.length < 5) {
      skipped += 1;
      continue;
    }
    const attendanceDate = String(data[0] ?? '').slice(0, 10);
    const studentNo = data.length > 2 ? String(data[2] ?? '').trim() : '';
    const studentName = data.length > 3 ? String(data[3] ?? '').trim() : '';
    const student = studentStmt.get(
      row.class_id, row.term_id, studentNo, studentNo,
      studentNo, studentName, studentName, studentNo,
    ) as { id: number } | undefined;
    if (!attendanceDate || !student) {
      skipped += 1;
      continue;
    }
    const fifth = data.length > 5 ? String(data[5] ?? '').trim() : '';
    const sixth = data.length > 6 ? String(data[6] ?? '').trim() : '';
    const seventh = data.length > 7 ? String(data[7] ?? '').trim() : '';
    let arriveAt: string;
    let leaveAt: string;
    let reason: string;
    if (timePattern.test(fifth) || (!fifth && seventh && !timePattern.test(seventh))) {
      arriveAt = fifth;
      leaveAt = sixth;
      reason = seventh;
    } else {
      reason = fifth;
      arriveAt = sixth;
      leaveAt = seventh;
    }
    const result = insertStmt.run(
      student.id, row.class_id, row.term_id, attendanceDate,
      String(data[4] ?? '出勤').trim() || '出勤', arriveAt, leaveAt,
      reason, data.length > 8 ? String(data[8] ?? '').trim() : '', row.row_no,
    );
    if (result.changes > 0) migrated += 1;
    else skipped += 1;
  }
  conn.prepare('INSERT OR REPLACE INTO app_flags(key, value) VALUES(?,?)').run(
    'attendance_v10_migration',
    JSON.stringify({ migrated, skipped }),
  );
}

function migration11(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS score_exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        exam_date TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS score_subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        full_score REAL NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS score_exam_subjects (
        exam_id INTEGER NOT NULL REFERENCES score_exams(id) ON DELETE CASCADE,
        subject_id INTEGER NOT NULL REFERENCES score_subjects(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(exam_id, subject_id)
    );

    INSERT OR IGNORE INTO score_exams(class_id, term_id, name, exam_date, sort_order)
    SELECT class_id, term_id, exam_name, MAX(exam_date), MIN(id)
    FROM exam_records GROUP BY class_id, term_id, exam_name;

    INSERT OR IGNORE INTO score_subjects(class_id, term_id, name, sort_order)
    SELECT class_id, term_id, subject, MIN(id)
    FROM exam_records GROUP BY class_id, term_id, subject;
  `);
}

function migration12(conn: Database): void {
  const taskColumns: Array<[string, string]> = [
    ['template_id', 'INTEGER REFERENCES class_task_templates(id) ON DELETE SET NULL'],
    ['completed_at', "TEXT NOT NULL DEFAULT ''"],
    ['completion_result', "TEXT NOT NULL DEFAULT ''"],
    ['closed_with_missing_count', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [column, definition] of taskColumns) {
    addColumn(conn, 'class_tasks', column, definition);
  }
  const itemColumns: Array<[string, string]> = [
    ['reminder_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_reminded_at', "TEXT NOT NULL DEFAULT ''"],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [column, definition] of itemColumns) {
    addColumn(conn, 'class_task_items', column, definition);
  }
  const dutyColumns: Array<[string, string]> = [
    ['rotation_rule_id', 'INTEGER REFERENCES duty_rotation_rules(id) ON DELETE SET NULL'],
    ['rotation_index', 'INTEGER'],
    ['completed_at', "TEXT NOT NULL DEFAULT ''"],
    ['completion_result', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [column, definition] of dutyColumns) {
    addColumn(conn, 'duty_assignments', column, definition);
  }
  conn.exec(`
    CREATE TABLE IF NOT EXISTS class_task_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT '材料收集',
        material_name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        default_due_days INTEGER NOT NULL DEFAULT 7,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS class_task_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES class_tasks(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES class_task_items(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(item_id, stored_name)
    );

    CREATE TABLE IF NOT EXISTS duty_rotation_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        area TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL DEFAULT '',
        weekday_mask INTEGER NOT NULL DEFAULT 31,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS duty_rotation_members (
        rule_id INTEGER NOT NULL REFERENCES duty_rotation_rules(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(rule_id, student_id),
        UNIQUE(rule_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_class_task_templates_scope
        ON class_task_templates(class_id, term_id, enabled, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_class_task_attachments_task
        ON class_task_attachments(task_id, item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_duty_rotation_scope
        ON duty_rotation_rules(class_id, term_id, enabled, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_duty_rotation_members
        ON duty_rotation_members(rule_id, position, student_id);
    CREATE INDEX IF NOT EXISTS idx_duty_assignment_student_date
        ON duty_assignments(class_id, term_id, student_id, duty_date, deleted_at);
  `);
}

function migration13(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS point_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '日常行为',
        metric TEXT NOT NULL DEFAULT '周期扣分',
        threshold REAL NOT NULL DEFAULT 5,
        period_days INTEGER NOT NULL DEFAULT 7,
        priority TEXT NOT NULL DEFAULT '重要',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS point_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        rule_id INTEGER REFERENCES point_rules(id) ON DELETE SET NULL,
        occurred_at TEXT NOT NULL DEFAULT '',
        period_key TEXT NOT NULL DEFAULT '',
        amount REAL NOT NULL,
        category TEXT NOT NULL DEFAULT '日常行为',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '有效',
        reversed_at TEXT NOT NULL DEFAULT '',
        reversal_reason TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '班主任',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS point_rule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        reference_date TEXT NOT NULL,
        created_count INTEGER NOT NULL DEFAULT 0,
        resolved_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS point_rule_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES point_rule_runs(id) ON DELETE CASCADE,
        rule_id INTEGER NOT NULL REFERENCES point_rules(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        value REAL NOT NULL DEFAULT 0,
        threshold REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '新命中',
        task_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
        resolved_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(rule_id, student_id, period_start, period_end)
    );

    CREATE TABLE IF NOT EXISTS point_migration_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        source_sheet TEXT NOT NULL DEFAULT '日常行为积分',
        source_version TEXT NOT NULL DEFAULT 'v1',
        source_rows INTEGER NOT NULL DEFAULT 0,
        imported_entries INTEGER NOT NULL DEFAULT 0,
        skipped_entries INTEGER NOT NULL DEFAULT 0,
        report TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, source_sheet, source_version)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_point_ledger_source_key
        ON point_ledger(class_id, term_id, source_key)
        WHERE source_key<>'';
    CREATE INDEX IF NOT EXISTS idx_point_ledger_scope_date
        ON point_ledger(class_id, term_id, occurred_at, student_id, status);
    CREATE INDEX IF NOT EXISTS idx_point_ledger_student
        ON point_ledger(class_id, term_id, student_id, status, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_point_rules_scope
        ON point_rules(class_id, term_id, enabled, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_point_rule_hits_scope
        ON point_rule_hits(class_id, term_id, status, period_end, student_id);
  `);
  const examColumns: Array<[string, string]> = [
    ['exam_id', 'INTEGER REFERENCES score_exams(id)'],
    ['subject_id', 'INTEGER REFERENCES score_subjects(id)'],
    ['record_status', "TEXT NOT NULL DEFAULT '正常'"],
    ['note', "TEXT NOT NULL DEFAULT ''"],
    ['import_run_id', 'INTEGER'],
  ];
  for (const [column, definition] of examColumns) {
    addColumn(conn, 'exam_records', column, definition);
  }
  conn.exec(`
    UPDATE exam_records SET exam_id=(
        SELECT x.id FROM score_exams x
        WHERE x.class_id=exam_records.class_id AND x.term_id=exam_records.term_id
          AND x.name=exam_records.exam_name
    ) WHERE exam_id IS NULL;

    UPDATE exam_records SET subject_id=(
        SELECT s.id FROM score_subjects s
        WHERE s.class_id=exam_records.class_id AND s.term_id=exam_records.term_id
          AND s.name=exam_records.subject
    ) WHERE subject_id IS NULL;

    INSERT OR IGNORE INTO score_exam_subjects(exam_id, subject_id, sort_order)
    SELECT exam_id, subject_id, MIN(id) FROM exam_records
    WHERE exam_id IS NOT NULL AND subject_id IS NOT NULL
    GROUP BY exam_id, subject_id;

    CREATE TABLE IF NOT EXISTS score_import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        request_id TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL DEFAULT '',
        duplicate_strategy TEXT NOT NULL DEFAULT 'update',
        imported INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS score_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        metric TEXT NOT NULL,
        subject_id INTEGER REFERENCES score_subjects(id) ON DELETE SET NULL,
        threshold REAL NOT NULL DEFAULT 10,
        priority TEXT NOT NULL DEFAULT '重要',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS score_rule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        rules_evaluated INTEGER NOT NULL DEFAULT 0,
        students_evaluated INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_count INTEGER NOT NULL DEFAULT 0,
        reopened_count INTEGER NOT NULL DEFAULT 0,
        resolved_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'success',
        error TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS score_rule_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES score_rules(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        status TEXT NOT NULL DEFAULT '待处理',
        current_value REAL NOT NULL DEFAULT 0,
        previous_exam_id INTEGER REFERENCES score_exams(id) ON DELETE SET NULL,
        current_exam_id INTEGER REFERENCES score_exams(id) ON DELETE SET NULL,
        task_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
        first_hit_at TEXT NOT NULL DEFAULT '',
        last_hit_at TEXT NOT NULL DEFAULT '',
        handled_at TEXT NOT NULL DEFAULT '',
        resolved_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, rule_id, student_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_score_import_request
        ON score_import_runs(class_id, term_id, request_id) WHERE request_id<>'';
    CREATE INDEX IF NOT EXISTS idx_score_exams_scope
        ON score_exams(class_id, term_id, exam_date, sort_order);
    CREATE INDEX IF NOT EXISTS idx_score_subjects_scope
        ON score_subjects(class_id, term_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_exam_records_config
        ON exam_records(class_id, term_id, exam_id, subject_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_score_rule_runs
        ON score_rule_runs(class_id, term_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_score_rule_hits
        ON score_rule_hits(class_id, term_id, rule_id, status, student_id);
  `);
}

function migration14(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS fund_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT '支出',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        UNIQUE(class_id, term_id, name, direction)
    );

    CREATE TABLE IF NOT EXISTS fund_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        period_key TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        opening_balance REAL NOT NULL DEFAULT 0,
        income_total REAL NOT NULL DEFAULT 0,
        expense_total REAL NOT NULL DEFAULT 0,
        closing_balance REAL NOT NULL DEFAULT 0,
        counted_balance REAL NOT NULL DEFAULT 0,
        difference REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '已结算',
        note TEXT NOT NULL DEFAULT '',
        settled_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, period_key)
    );

    CREATE TABLE IF NOT EXISTS fund_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        occurred_at TEXT NOT NULL DEFAULT '',
        direction TEXT NOT NULL DEFAULT '支出',
        amount REAL NOT NULL,
        category_id INTEGER REFERENCES fund_categories(id) ON DELETE SET NULL,
        category_name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        handler TEXT NOT NULL DEFAULT '',
        witness TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '有效',
        settlement_id INTEGER REFERENCES fund_settlements(id) ON DELETE SET NULL,
        reversed_at TEXT NOT NULL DEFAULT '',
        reversal_reason TEXT NOT NULL DEFAULT '',
        reversal_of_id INTEGER REFERENCES fund_ledger(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '班主任',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS fund_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_id INTEGER NOT NULL REFERENCES fund_ledger(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(ledger_id, stored_name)
    );

    CREATE TABLE IF NOT EXISTS fund_migration_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        source_sheet TEXT NOT NULL DEFAULT '班费管理',
        source_version TEXT NOT NULL DEFAULT 'v1',
        source_rows INTEGER NOT NULL DEFAULT 0,
        imported_entries INTEGER NOT NULL DEFAULT 0,
        skipped_entries INTEGER NOT NULL DEFAULT 0,
        report TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, source_sheet, source_version)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_fund_ledger_source_key
        ON fund_ledger(class_id, term_id, source_key)
        WHERE source_key<>'';
    CREATE INDEX IF NOT EXISTS idx_fund_ledger_scope_date
        ON fund_ledger(class_id, term_id, occurred_at, status);
    CREATE INDEX IF NOT EXISTS idx_fund_ledger_settlement
        ON fund_ledger(class_id, term_id, settlement_id, status);
    CREATE INDEX IF NOT EXISTS idx_fund_categories_scope
        ON fund_categories(class_id, term_id, direction, enabled, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_fund_settlements_scope
        ON fund_settlements(class_id, term_id, period_start, period_end, status);
    CREATE INDEX IF NOT EXISTS idx_fund_attachments_ledger
        ON fund_attachments(ledger_id, created_at);
  `);
}

function migration15(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS comment_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        comment_type TEXT NOT NULL DEFAULT '学期评语',
        content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS comment_generation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        template_id INTEGER REFERENCES comment_templates(id) ON DELETE SET NULL,
        comment_type TEXT NOT NULL DEFAULT '学期评语',
        requested_count INTEGER NOT NULL DEFAULT 0,
        created_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        protected_count INTEGER NOT NULL DEFAULT 0,
        missing_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS student_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        template_id INTEGER REFERENCES comment_templates(id) ON DELETE SET NULL,
        generation_run_id INTEGER REFERENCES comment_generation_runs(id) ON DELETE SET NULL,
        comment_type TEXT NOT NULL DEFAULT '学期评语',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '草稿',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        is_manually_edited INTEGER NOT NULL DEFAULT 0,
        edited_at TEXT NOT NULL DEFAULT '',
        edited_by TEXT NOT NULL DEFAULT '',
        reviewed_at TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT NOT NULL DEFAULT '',
        review_note TEXT NOT NULL DEFAULT '',
        sent_at TEXT NOT NULL DEFAULT '',
        delivery_method TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS comment_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL REFERENCES student_comments(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        change_type TEXT NOT NULL DEFAULT 'create',
        note TEXT NOT NULL DEFAULT '',
        changed_by TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(comment_id, version_no)
    );

    CREATE TABLE IF NOT EXISTS comment_migration_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        source_sheet TEXT NOT NULL DEFAULT '评语管理',
        source_version TEXT NOT NULL DEFAULT 'v1',
        source_rows INTEGER NOT NULL DEFAULT 0,
        imported_entries INTEGER NOT NULL DEFAULT 0,
        skipped_entries INTEGER NOT NULL DEFAULT 0,
        report TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, source_sheet, source_version)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_student_comments_active_unique
        ON student_comments(class_id, term_id, student_id, comment_type)
        WHERE deleted_at='';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_student_comments_source_key
        ON student_comments(class_id, term_id, source_key)
        WHERE source_key<>'';
    CREATE INDEX IF NOT EXISTS idx_student_comments_scope
        ON student_comments(class_id, term_id, status, comment_type, student_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_comment_templates_scope
        ON comment_templates(class_id, term_id, enabled, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_comment_versions_comment
        ON comment_versions(comment_id, version_no DESC);
    CREATE INDEX IF NOT EXISTS idx_comment_generation_runs_scope
        ON comment_generation_runs(class_id, term_id, created_at);
  `);
}

function migration16(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS meeting_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT '主题班会',
        content TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS meeting_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        template_id INTEGER REFERENCES meeting_templates(id) ON DELETE SET NULL,
        held_on TEXT NOT NULL,
        topic TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT '主题班会',
        content TEXT NOT NULL DEFAULT '',
        participation TEXT NOT NULL DEFAULT '',
        conclusion TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '已记录',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        work_item_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
        legacy_row_no INTEGER,
        legacy_payload TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS meeting_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL REFERENCES meeting_records(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        participation TEXT NOT NULL DEFAULT '参加',
        note TEXT NOT NULL DEFAULT '',
        UNIQUE(meeting_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS meeting_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL REFERENCES meeting_records(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '班主任',
        due_at TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '待处理',
        work_item_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS activity_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        activity_type TEXT NOT NULL DEFAULT '其他',
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, name)
    );

    CREATE TABLE IF NOT EXISTS activity_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        template_id INTEGER REFERENCES activity_templates(id) ON DELETE SET NULL,
        occurred_on TEXT NOT NULL,
        name TEXT NOT NULL,
        activity_type TEXT NOT NULL DEFAULT '其他',
        budget REAL NOT NULL DEFAULT 0,
        participant_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        retrospective TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '计划中',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        work_item_id INTEGER REFERENCES student_tasks(id) ON DELETE SET NULL,
        legacy_row_no INTEGER,
        legacy_payload TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS activity_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        participation TEXT NOT NULL DEFAULT '参加',
        note TEXT NOT NULL DEFAULT '',
        UNIQUE(activity_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS activity_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS diary_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        diary_date TEXT NOT NULL,
        weather TEXT NOT NULL DEFAULT '',
        work TEXT NOT NULL DEFAULT '',
        event TEXT NOT NULL DEFAULT '',
        reflection TEXT NOT NULL DEFAULT '',
        todo TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT NOT NULL DEFAULT '',
        legacy_row_no INTEGER,
        legacy_payload TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS diary_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        diary_id INTEGER NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL,
        link_id INTEGER,
        student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT '',
        UNIQUE(diary_id, link_type, link_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER REFERENCES terms(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '未分类',
        tags TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL DEFAULT '',
        file_mtime REAL NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT '同步',
        linked_source_type TEXT NOT NULL DEFAULT '',
        linked_source_id INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_note_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES knowledge_notes(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL,
        link_id INTEGER,
        label TEXT NOT NULL DEFAULT '',
        UNIQUE(note_id, link_type, link_id)
    );

    CREATE TABLE IF NOT EXISTS domain4_migration_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        source_sheet TEXT NOT NULL,
        source_version TEXT NOT NULL DEFAULT 'v1',
        source_rows INTEGER NOT NULL DEFAULT 0,
        imported_entries INTEGER NOT NULL DEFAULT 0,
        skipped_entries INTEGER NOT NULL DEFAULT 0,
        report TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, source_sheet, source_version)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_source_key
        ON meeting_records(class_id, term_id, source_key)
        WHERE source_key<>'';
    CREATE INDEX IF NOT EXISTS idx_meeting_scope_date
        ON meeting_records(class_id, term_id, held_on, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_meeting_participants_student
        ON meeting_participants(student_id, meeting_id);
    CREATE INDEX IF NOT EXISTS idx_activity_source_key
        ON activity_records(class_id, term_id, source_key)
        WHERE source_key<>'';
    CREATE INDEX IF NOT EXISTS idx_activity_scope_date
        ON activity_records(class_id, term_id, occurred_on, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_activity_participants_student
        ON activity_participants(student_id, activity_id);
    CREATE INDEX IF NOT EXISTS idx_diary_scope_date
        ON diary_entries(class_id, term_id, diary_date, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_diary_links_source
        ON diary_links(link_type, link_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_scope_category
        ON knowledge_notes(class_id, term_id, category, sync_status);
  `);
}

function migration17(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS report_archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        report_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        archived_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, report_type, period_start, period_end, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_report_archives_scope
        ON report_archives(class_id, term_id, report_type, period_start, period_end);
  `);
}

function migration18(conn: Database): void {
  addColumn(conn, 'communications', 'source_type', "TEXT NOT NULL DEFAULT 'manual'");
  addColumn(conn, 'communications', 'source_id', "TEXT NOT NULL DEFAULT ''");
  addColumn(conn, 'communications', 'source_key', "TEXT NOT NULL DEFAULT ''");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'web',
        actor_id TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL DEFAULT '{}',
        arguments_hash TEXT NOT NULL,
        confirmation_hash TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TEXT NOT NULL,
        backup_file TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        confirmed_at TEXT NOT NULL DEFAULT '',
        executed_at TEXT NOT NULL DEFAULT '',
        UNIQUE(session_id, arguments_hash, status)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_actions_session
        ON agent_actions(session_id, actor_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_expiry
        ON agent_actions(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_communications_source_key
        ON communications(class_id, term_id, source_key)
        WHERE source_key<>'';
  `);
}

function migration19(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS wechat_reminder_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        task_id INTEGER NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
        recipient TEXT NOT NULL,
        reminder_key TEXT NOT NULL,
        sent_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, task_id, recipient, reminder_key)
    );
    CREATE INDEX IF NOT EXISTS idx_wechat_reminder_receipts_scope
        ON wechat_reminder_receipts(class_id, term_id, recipient, sent_at);
  `);
}

function migration20(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS health_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric TEXT NOT NULL UNIQUE,
        target_value REAL,
        unit TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS health_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        next_plan TEXT NOT NULL DEFAULT '',
        metrics_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(period_type, period_start, period_end)
    );
    CREATE TABLE IF NOT EXISTS health_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_type TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0,
        remind_time TEXT NOT NULL DEFAULT '21:00',
        message TEXT NOT NULL DEFAULT '',
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
}

function migration21(conn: Database): void {
  addColumn(conn, 'agent_sessions', 'title', "TEXT NOT NULL DEFAULT '新会话'");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS agent_model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'web',
        actor_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'success',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_model_usage_created
        ON agent_model_usage(channel, model, status, created_at);
  `);
}

function migration22(conn: Database): void {
  const columns: Array<[string, string]> = [
    ['subject_group', "TEXT NOT NULL DEFAULT '必考'"],
    ['score_type', "TEXT NOT NULL DEFAULT '原始分'"],
  ];
  for (const [column, definition] of columns) {
    addColumn(conn, 'score_subjects', column, definition);
  }
  conn.exec(`
    CREATE TABLE IF NOT EXISTS score_term_settings (
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT '固定科目',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        PRIMARY KEY(class_id, term_id)
    );

    CREATE TABLE IF NOT EXISTS student_score_subjects (
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        subject_id INTEGER NOT NULL REFERENCES score_subjects(id) ON DELETE CASCADE,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        PRIMARY KEY(class_id, term_id, student_id, subject_id)
    );

    CREATE TABLE IF NOT EXISTS student_score_profiles (
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        PRIMARY KEY(class_id, term_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_student_score_subjects_scope
        ON student_score_subjects(class_id, term_id, student_id);
  `);
}

function migration23(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS student_score_profiles (
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        PRIMARY KEY(class_id, term_id, student_id)
    );
  `);
}

function migration24(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS school_calendar_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        calendar_date TEXT NOT NULL,
        day_type TEXT NOT NULL DEFAULT '上课日',
        title TEXT NOT NULL DEFAULT '',
        is_school_day INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_filename TEXT NOT NULL DEFAULT '',
        source_row INTEGER,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, calendar_date)
    );

    CREATE TABLE IF NOT EXISTS school_calendar_import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL DEFAULT '',
        imported INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        conflict_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_school_calendar_scope_date
        ON school_calendar_days(class_id, term_id, calendar_date);
    CREATE INDEX IF NOT EXISTS idx_school_calendar_import_scope
        ON school_calendar_import_runs(class_id, term_id, created_at);
  `);
}

function migration25(conn: Database): void {
  addColumn(conn, 'students', 'photo_path', "TEXT NOT NULL DEFAULT ''");
}

function migration26(conn: Database): void {
  addColumn(conn, 'agent_sessions', 'channel', "TEXT NOT NULL DEFAULT 'web'");
  addColumn(conn, 'agent_sessions', 'actor_id', "TEXT NOT NULL DEFAULT ''");
  conn.exec(`
    UPDATE agent_sessions
       SET channel='wechat', actor_id=substr(session_id, 8)
     WHERE session_id LIKE 'wechat:%' AND actor_id='';
    UPDATE agent_sessions
       SET channel='web', actor_id='local-user'
     WHERE session_id LIKE 'web:%' AND actor_id='';
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner
        ON agent_sessions(channel, actor_id, updated_at);
  `);
}

function migration27(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS student_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        group_type TEXT NOT NULL DEFAULT '学习小组',
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '使用中',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, group_type, name)
    );

    CREATE TABLE IF NOT EXISTS student_group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL REFERENCES student_groups(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT '成员',
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '在组',
        joined_at TEXT DEFAULT (datetime('now','localtime')),
        left_at TEXT NOT NULL DEFAULT '',
        UNIQUE(group_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_student_groups_scope
        ON student_groups(class_id, term_id, status, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_student_group_members_student
        ON student_group_members(student_id, status);

    CREATE TABLE IF NOT EXISTS dorm_rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        building TEXT NOT NULL DEFAULT '',
        floor TEXT NOT NULL DEFAULT '',
        room_no TEXT NOT NULL,
        gender_limit TEXT NOT NULL DEFAULT '不限',
        capacity INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '使用中',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(building, floor, room_no)
    );

    CREATE TABLE IF NOT EXISTS dorm_beds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES dorm_rooms(id) ON DELETE CASCADE,
        bed_no TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '可用',
        UNIQUE(room_id, bed_no)
    );

    CREATE TABLE IF NOT EXISTS dorm_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        bed_id INTEGER NOT NULL REFERENCES dorm_beds(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT '在住',
        move_in_at TEXT NOT NULL DEFAULT '',
        move_out_at TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dorm_active_student
        ON dorm_assignments(student_id, term_id)
        WHERE status='在住';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dorm_active_bed
        ON dorm_assignments(bed_id, term_id)
        WHERE status='在住';
    CREATE INDEX IF NOT EXISTS idx_dorm_assignments_scope
        ON dorm_assignments(class_id, term_id, status, student_id);
  `);
}

function migration28(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS dorm_room_leaders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        room_id INTEGER NOT NULL REFERENCES dorm_rooms(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT '在任',
        assigned_at TEXT NOT NULL DEFAULT '',
        ended_at TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_dorm_active_room_leader
        ON dorm_room_leaders(class_id, term_id, room_id)
        WHERE status='在任';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dorm_active_student_leader
        ON dorm_room_leaders(class_id, term_id, student_id)
        WHERE status='在任';
    CREATE INDEX IF NOT EXISTS idx_dorm_room_leaders_scope
        ON dorm_room_leaders(class_id, term_id, room_id, status);

    CREATE TABLE IF NOT EXISTS dorm_inspections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        inspection_date TEXT NOT NULL,
        inspection_time TEXT NOT NULL DEFAULT '',
        inspector TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '已完成',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS dorm_inspection_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inspection_id INTEGER NOT NULL REFERENCES dorm_inspections(id) ON DELETE CASCADE,
        room_id INTEGER NOT NULL REFERENCES dorm_rooms(id) ON DELETE RESTRICT,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT '在寝',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(inspection_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dorm_inspections_scope
        ON dorm_inspections(class_id, term_id, inspection_date, id);
    CREATE INDEX IF NOT EXISTS idx_dorm_inspection_records_inspection
        ON dorm_inspection_records(inspection_id, room_id, status);
  `);
}

function migration29(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS timetable_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        period_no INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        start_time TEXT NOT NULL DEFAULT '',
        end_time TEXT NOT NULL DEFAULT '',
        session_type TEXT NOT NULL DEFAULT '普通课',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, period_no)
    );

    CREATE TABLE IF NOT EXISTS timetable_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        weekday INTEGER NOT NULL,
        period_no INTEGER NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        teacher_name TEXT NOT NULL DEFAULT '',
        room TEXT NOT NULL DEFAULT '',
        session_type TEXT NOT NULL DEFAULT '普通课',
        week_pattern TEXT NOT NULL DEFAULT '全周',
        week_start INTEGER NOT NULL DEFAULT 1,
        week_end INTEGER NOT NULL DEFAULT 99,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '启用',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, weekday, period_no, week_pattern, week_start, week_end)
    );

    CREATE TABLE IF NOT EXISTS timetable_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        change_date TEXT NOT NULL,
        period_no INTEGER NOT NULL,
        action TEXT NOT NULL DEFAULT '调课',
        subject TEXT NOT NULL DEFAULT '',
        teacher_name TEXT NOT NULL DEFAULT '',
        room TEXT NOT NULL DEFAULT '',
        session_type TEXT NOT NULL DEFAULT '普通课',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '生效',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, change_date, period_no)
    );

    CREATE TABLE IF NOT EXISTS timetable_import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL DEFAULT '',
        imported_periods INTEGER NOT NULL DEFAULT 0,
        imported_entries INTEGER NOT NULL DEFAULT 0,
        updated_entries INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(class_id, term_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_timetable_periods_scope
        ON timetable_periods(class_id, term_id, period_no, enabled);
    CREATE INDEX IF NOT EXISTS idx_timetable_entries_scope
        ON timetable_entries(class_id, term_id, weekday, period_no, status);
    CREATE INDEX IF NOT EXISTS idx_timetable_changes_scope
        ON timetable_changes(class_id, term_id, change_date, period_no, status);
    CREATE INDEX IF NOT EXISTS idx_timetable_import_scope
        ON timetable_import_runs(class_id, term_id, created_at);
  `);
}

function migration30(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS evidence_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
        evidence_kind TEXT NOT NULL DEFAULT '请假凭证',
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        source_channel TEXT NOT NULL DEFAULT 'web',
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        delete_reason TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_scope
        ON evidence_attachments(class_id, term_id, owner_type, owner_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_evidence_student
        ON evidence_attachments(class_id, term_id, student_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_evidence_sha256
        ON evidence_attachments(sha256, deleted_at);
  `);
}

function migration31(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS tool_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '教务系统',
        icon TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_tool_links_visible
        ON tool_links(deleted_at, pinned DESC, sort_order, id);
  `);
}

function migration33(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS teacher_classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_name TEXT NOT NULL DEFAULT '',
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT '任课教师',
        subjects TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(teacher_name, class_id)
    );

    CREATE INDEX IF NOT EXISTS idx_teacher_classes_teacher
        ON teacher_classes(teacher_name, enabled, sort_order);
  `);
}

function migration34(conn: Database): void {
  addColumn(conn, 'students', '监护人关系', "TEXT DEFAULT ''");
  addColumn(conn, 'students', '监护人2职业', "TEXT DEFAULT ''");
}

function migration32(conn: Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notification_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        term_id INTEGER NOT NULL REFERENCES terms(id),
        name TEXT NOT NULL,
        scene TEXT NOT NULL DEFAULT '放假通知',
        content TEXT NOT NULL DEFAULT '',
        variables_json TEXT NOT NULL DEFAULT '[]',
        is_system INTEGER NOT NULL DEFAULT 0,
        is_owner_saved INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        deleted_at TEXT NOT NULL DEFAULT '',
        deleted_by TEXT NOT NULL DEFAULT '',
        UNIQUE(class_id, term_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_notification_templates_scope
        ON notification_templates(class_id, term_id, scene, enabled, deleted_at);
  `);
}

export const MIGRATIONS: Record<number, (conn: Database) => void> = {
  2: migration2,
  3: migration3,
  4: migration4,
  5: migration5,
  6: migration6,
  7: migration7,
  8: migration8,
  9: migration9,
  10: migration10,
  11: migration11,
  12: migration12,
  13: migration13,
  14: migration14,
  15: migration15,
  16: migration16,
  17: migration17,
  18: migration18,
  19: migration19,
  20: migration20,
  21: migration21,
  22: migration22,
  23: migration23,
  24: migration24,
  25: migration25,
  26: migration26,
  27: migration27,
  28: migration28,
  29: migration29,
  30: migration30,
  31: migration31,
  32: migration32,
  33: migration33,
  34: migration34,
};

/** 基础 schema（v1）：与 Python init_schema 的 executescript 逐条一致。 */
export function applyBaseSchema(conn: Database): void {
  conn.exec(`
  -- 学生信息（结构化，学号唯一，导入合并去重的依据）
  CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      学号 TEXT UNIQUE,
      姓名 TEXT,
      性别 TEXT,
      出生年月 TEXT,
      民族 TEXT,
      家庭住址 TEXT,
      监护人姓名 TEXT,
      监护人电话 TEXT,
      监护人关系 TEXT DEFAULT '',
      监护人职业 TEXT,
      是否住校 TEXT,
      特长 TEXT,
      班级任职 TEXT,
      备注 TEXT,
      监护人2姓名 TEXT DEFAULT '',
      监护人2电话 TEXT DEFAULT '',
      监护人2关系 TEXT DEFAULT '',
      监护人2职业 TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  `);
  // 兼容旧库：补全新列
  for (const [col, typ] of [
    ['监护人2姓名', "TEXT DEFAULT ''"],
    ['监护人2电话', "TEXT DEFAULT ''"],
    ['监护人2关系', "TEXT DEFAULT ''"],
    ['监护人关系', "TEXT DEFAULT ''"],
    ['监护人2职业', "TEXT DEFAULT ''"],
  ] as Array<[string, string]>) {
    try {
      conn.exec(`ALTER TABLE students ADD COLUMN "${col}" ${typ}`);
    } catch {
      // 列已存在
    }
  }
  conn.exec(`
  -- 通用工作表：表头元数据
  CREATE TABLE IF NOT EXISTS sheet_meta (
      sheet TEXT PRIMARY KEY,
      headers TEXT NOT NULL DEFAULT '[]',
      category TEXT DEFAULT '',
      group_name TEXT DEFAULT 'teacher'
  );

  -- 通用工作表：数据行（JSON 数组，与 headers 对齐）
  CREATE TABLE IF NOT EXISTS sheet_rows (
      sheet TEXT NOT NULL,
      row_no INTEGER NOT NULL,           -- 逻辑行号（1 起，稳定不变）
      data TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (sheet, row_no)
  );

  -- 座位表
  CREATE TABLE IF NOT EXISTS seating (
      r INTEGER NOT NULL,
      c INTEGER NOT NULL,
      val TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (r, c)
  );

  CREATE TABLE IF NOT EXISTS app_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
  );

  -- P0 核心流程：结构化记录，统一通过 student_id 关联学生
  CREATE TABLE IF NOT EXISTS student_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      description TEXT NOT NULL,
      handling TEXT DEFAULT '',
      parent_contacted INTEGER NOT NULL DEFAULT 0,
      needs_followup INTEGER NOT NULL DEFAULT 0,
      followup_due TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT '已完成',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS student_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      event_id INTEGER REFERENCES student_events(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      source TEXT DEFAULT '手动创建',
      due_at TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT '普通',
      status TEXT NOT NULL DEFAULT '待处理',
      notes TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS focus_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT DEFAULT '',
      action_plan TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT '待确认',
      next_review_at TEXT DEFAULT '',
      started_at TEXT DEFAULT (date('now','localtime')),
      ended_at TEXT DEFAULT '',
      conclusion TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS communications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      communicated_at TEXT NOT NULL,
      method TEXT NOT NULL,
      reason TEXT NOT NULL,
      summary TEXT NOT NULL,
      feedback TEXT DEFAULT '',
      agreement TEXT DEFAULT '',
      followup_at TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT '已完成',
      event_id INTEGER REFERENCES student_events(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- P1：结构化成绩记录（支持长表与宽表 Excel 导入）
  CREATE TABLE IF NOT EXISTS exam_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      exam_name TEXT NOT NULL,
      exam_date TEXT DEFAULT '',
      subject TEXT NOT NULL,
      score REAL,
      rank INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(student_id, exam_name, subject)
  );

  -- P1：考勤规则，命中后生成待办提醒
  CREATE TABLE IF NOT EXISTS attendance_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      metric TEXT NOT NULL,
      threshold INTEGER NOT NULL DEFAULT 1,
      period_days INTEGER NOT NULL DEFAULT 7,
      priority TEXT NOT NULL DEFAULT '重要',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- P1：班级任务与学生材料收集项
  CREATE TABLE IF NOT EXISTS class_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT '材料收集',
      start_at TEXT DEFAULT '',
      due_at TEXT DEFAULT '',
      material_name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT '进行中',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS class_task_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES class_tasks(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT '未提交',
      note TEXT DEFAULT '',
      submitted_at TEXT DEFAULT '',
      UNIQUE(task_id, student_id)
  );

  -- P1：值日安排
  CREATE TABLE IF NOT EXISTS duty_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duty_date TEXT NOT NULL,
      area TEXT NOT NULL,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT '待完成',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(duty_date, area, student_id)
  );
  `);
}

/** 与 Python schema_version 一致。 */
export function schemaVersion(conn: Database): number {
  const row = conn.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version: number | null };
  return row.version ?? 0;
}

/**
 * 初始化 schema：迁移表、版本标记、高版本拒绝、迁移前备份、基础 schema + 待执行迁移。
 * 与 Python init_schema 逻辑逐条对应。
 */
export function initSchema(conn: Database, existingDatabase: boolean, backup: (label: string) => void): void {
  const migrationTableExists = conn.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  ).get() !== undefined;
  if (!migrationTableExists && existingDatabase && Object.keys(MIGRATIONS).length > 0) {
    backup(`pre-migrate-v${Math.min(...Object.keys(MIGRATIONS).map(Number))}`);
  }
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  const marker = conn.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version: number | null };
  if (marker.version === null) {
    conn.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(BASE_SCHEMA_VERSION);
    // better-sqlite3 语句自动提交，无需（也不能）显式 COMMIT；
    // 与 Python 的 conn.commit() 语义等价，保证后续备份 API 可靠。
  }
  const current = schemaVersion(conn);
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${current} 高于当前程序支持的版本 ${CURRENT_SCHEMA_VERSION}`);
  }
  const pending = Object.keys(MIGRATIONS).map(Number).filter((version) => version > current).sort((a, b) => a - b);
  if (pending.length > 0 && existingDatabase && migrationTableExists) {
    backup(`pre-migrate-v${pending[0]}`);
  }

  applyBaseSchema(conn);

  for (const version of pending) {
    MIGRATIONS[version](conn);
    conn.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(version);
  }
}
