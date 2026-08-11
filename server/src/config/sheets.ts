/* MIG-05 工作表元数据与学生列定义（与 backend/app/config.py 一致）。 */
export interface SheetMeta {
  category: string;
  group: 'teacher' | 'personal';
}

export const SHEET_META: Record<string, SheetMeta> = {
  // 学生管理
  '学生信息总表': { category: '学生管理', group: 'teacher' },
  '特殊学生档案': { category: '学生管理', group: 'teacher' },
  '评语管理': { category: '学生管理', group: 'teacher' },
  // 教学管理
  '考勤管理': { category: '教学管理', group: 'teacher' },
  '成绩跟踪': { category: '教学管理', group: 'teacher' },
  '日常行为积分': { category: '教学管理', group: 'teacher' },
  // 班级事务
  '座位表': { category: '班级事务', group: 'teacher' },
  '家校沟通记录': { category: '班级事务', group: 'teacher' },
  '谈心记录': { category: '班级事务', group: 'teacher' },
  '班会记录': { category: '班级事务', group: 'teacher' },
  '班费管理': { category: '班级事务', group: 'teacher' },
  '班委管理': { category: '班级事务', group: 'teacher' },
  '班级活动': { category: '班级事务', group: 'teacher' },
  // 日志
  '班主任日志': { category: '日志', group: 'teacher' },
  '工作计划总结': { category: '日志', group: 'teacher' },
  // 健康
  '体重体脂追踪': { category: '健康管理', group: 'personal' },
  '运动记录': { category: '健康管理', group: 'personal' },
  '睡眠记录': { category: '健康管理', group: 'personal' },
  '饮食记录': { category: '健康管理', group: 'personal' },
  '月度总结': { category: '健康管理', group: 'personal' },
};

export const STUDENT_COLUMNS = ['学号', '姓名', '性别', '出生年月', '民族', '家庭住址', '监护人姓名',
  '监护人电话', '监护人职业', '是否住校', '特长', '班级任职', '备注',
  '监护人2姓名', '监护人2电话', '监护人2关系'];
