// 各工作表「添加记录」弹窗的字段配置
export const SHEET_FIELDS = {
  '考勤管理': [
    { name: 'date', label: '日期', ph: '如 2026-09-01' },
    { name: 'weekday', label: '星期', options: ['周一', '周二', '周三', '周四', '周五'] },
    { name: 'xh', label: '学号' },
    { name: 'name', label: '学生姓名' },
    { name: 'status', label: '出勤状态', options: ['出勤', '迟到', '请假', '缺勤'] },
    { name: 'reason', label: '请假原因' },
    { name: 'arrive', label: '到校时间' },
    { name: 'leave', label: '离校时间' },
    { name: 'note', label: '备注' }
  ],
  '家校沟通记录': [
    { name: 'date', label: '日期' },
    { name: 'student', label: '学生姓名' },
    { name: 'method', label: '沟通方式', options: ['电话', '微信', '面谈', '家访', '短信'] },
    { name: 'reason', label: '沟通原因' },
    { name: 'summary', label: '沟通内容摘要' },
    { name: 'feedback', label: '家长反馈' },
    { name: 'followup', label: '后续跟进' },
    { name: 'status', label: '完成状态', options: ['待跟进', '已解决', '持续关注'] }
  ],
  '谈心记录': [
    { name: 'date', label: '日期' },
    { name: 'student', label: '学生姓名' },
    { name: 'reason', label: '谈心原因' },
    { name: 'place', label: '谈心地点' },
    { name: 'summary', label: '谈心内容摘要' },
    { name: 'status', label: '学生状态' },
    { name: 'plan', label: '后续计划' },
    { name: 'next', label: '下次跟进时间' }
  ],
  '班会记录': [
    { name: 'date', label: '日期' },
    { name: 'week', label: '周次' },
    { name: 'topic', label: '主题' },
    { name: 'format', label: '形式', options: ['主题班会', '事务通知', '团队活动', '安全教育', '心理健康'] },
    { name: 'content', label: '主要内容' },
    { name: 'participation', label: '学生参与情况' },
    { name: 'effect', label: '效果评估' },
    { name: 'note', label: '备注' }
  ],
  '班主任日志': [
    { name: 'date', label: '日期' },
    { name: 'weekday', label: '星期', options: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] },
    { name: 'weather', label: '天气', options: ['晴', '多云', '阴', '雨', '雪'] },
    { name: 'work', label: '主要工作' },
    { name: 'event', label: '突发事件' },
    { name: 'reflection', label: '今日反思' },
    { name: 'todo', label: '待办事项' }
  ],
  '班费管理': [
    { name: 'date', label: '日期' },
    { name: 'type', label: '收支类型', options: ['收入', '支出'] },
    { name: 'amount', label: '金额' },
    { name: 'desc', label: '用途说明' },
    { name: 'handler', label: '经手人' },
    { name: 'witness', label: '证明人' },
    { name: 'note', label: '备注' }
  ],
  '评语管理': [
    { name: 'xh', label: '学号' },
    { name: 'name', label: '姓名' },
    { name: 'type', label: '评语类型', options: ['学期评语', '毕业评语', '日常评语'] },
    { name: 'content', label: '评语内容' },
    { name: 'status', label: '完成状态', options: ['草稿', '已完成', '已发送'] },
    { name: 'note', label: '备注' }
  ],
  '班委管理': [
    { name: 'duty', label: '职务' },
    { name: 'name', label: '姓名' },
    { name: 'desc', label: '职责描述' },
    { name: 'time', label: '任职时间' },
    { name: 'note', label: '备注' }
  ],
  '班级活动': [
    { name: 'date', label: '日期' },
    { name: 'name', label: '活动名称' },
    { name: 'type', label: '类型', options: ['文体活动', '社会实践', '志愿服务', '学科竞赛', '节日庆祝', '其他'] },
    { name: 'count', label: '参与人数' },
    { name: 'summary', label: '活动总结' },
    { name: 'award', label: '获奖情况' },
    { name: 'evidence', label: '佐证材料' },
    { name: 'note', label: '备注' }
  ],
  '日常行为积分': [
    { name: 'xh', label: '学号' },
    { name: 'name', label: '学生姓名' },
    { name: 'w1', label: '第1周' },
    { name: 'w2', label: '第2周' },
    { name: 'w3', label: '第3周' },
    { name: 'w4', label: '第4周' },
    { name: 'w5', label: '第5周' },
    { name: 'w6', label: '第6周' },
    { name: 'w7', label: '第7周' },
    { name: 'w8', label: '第8周' },
    { name: 'note', label: '备注' }
  ],
  '特殊学生档案': [
    { name: 'seq', label: '序号' },
    { name: 'name', label: '学生姓名' },
    { name: 'category', label: '类别' },
    { name: 'desc', label: '详细描述' },
    { name: 'caution', label: '注意事项' },
    { name: 'coach', label: '辅导记录' },
    { name: 'status', label: '跟进状态' },
    { name: 'updated', label: '最后更新' }
  ],
  '工作计划总结': [
    { name: 'term', label: '学期' },
    { name: 'plan', label: '计划内容' },
    { name: 'summary', label: '总结内容' }
  ],
  '体重体脂追踪': [
    { name: 'week', label: '周次' },
    { name: 'date', label: '称重日期' },
    { name: 'w_jin', label: '体重(斤)' },
    { name: 'w_kg', label: '体重(kg)' },
    { name: 'fat', label: '体脂率(%)' },
    { name: 'waist', label: '腰围(cm)' },
    { name: 'hip', label: '臀围(cm)' },
    { name: 'note', label: '备注' }
  ],
  '运动记录': [
    { name: 'date', label: '日期' },
    { name: 'weekday', label: '星期', options: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] },
    { name: 'type', label: '运动类型', options: ['力量训练', '有氧', '拉伸', '散步', '其他'] },
    { name: 'item', label: '具体项目' },
    { name: 'duration', label: '时长(分钟)' },
    { name: 'intensity', label: '强度', options: ['低', '中', '高'] },
    { name: 'calories', label: '消耗(千卡)' },
    { name: 'feeling', label: '运动感受' },
    { name: 'done', label: '是否完成', options: ['是', '否'] }
  ],
  '睡眠记录': [
    { name: 'date', label: '日期' },
    { name: 'bedtime', label: '入睡时间' },
    { name: 'waketime', label: '起床时间' },
    { name: 'duration', label: '睡眠时长(小时)' },
    { name: 'quality', label: '睡眠质量', options: ['优', '良', '一般', '差'] },
    { name: 'wakefeel', label: '起床感受' },
    { name: 'noon', label: '午休(分钟)' },
    { name: 'note', label: '备注' }
  ],
  '饮食记录': [
    { name: 'date', label: '日期' },
    { name: 'breakfast', label: '早餐' },
    { name: 'lunch', label: '午餐' },
    { name: 'dinner', label: '晚餐' },
    { name: 'snack', label: '加餐' },
    { name: 'protein', label: '蛋白质达标', options: ['达标', '未达标'] },
    { name: 'water', label: '饮水量(ml)' },
    { name: 'veggie', label: '蔬果份数' },
    { name: 'note', label: '备注' }
  ],
  '月度总结': [
    { name: 'month', label: '月份' },
    { name: 'summary', label: '总结' },
    { name: 'plan', label: '下月计划' }
  ]
}

// 顶部 Tab / 侧边导航路由配置
export const NAV = [
  {
    key: 'teacher', icon: 'School', title: '教师工作台', school: '汶川县七一映秀中学',
    groups: [
      { title: '工作台', items: [
        { page: 'dashboard', icon: 'LayoutDashboard', label: '今日工作台' },
        { page: 'tasks', icon: 'ClipboardList', label: '待办跟进' },
        { page: 'tools', icon: 'Link', label: '工作入口' }
      ] },
      { title: '学生跟进', items: [
        { page: 'students', icon: 'Users', label: '学生信息' },
        { page: 'special', icon: 'Tag', label: '关注事项' },
        { page: 'events', icon: 'FileEdit', label: '学生事件' },
        { page: 'parent-comm', icon: 'Phone', label: '家校沟通' }
      ] },
      { title: '教学管理', items: [
        { page: 'timetable', icon: 'CalendarDays', label: '课程表' },
        { page: 'attendance', icon: 'ClipboardCheck', label: '考勤管理' },
        { page: 'scores', icon: 'TrendingUp', label: '成绩跟踪' },
        { page: 'points', icon: 'Star', label: '行为积分' }
      ] },
      { title: '班级事务', items: [
        { page: 'class-tasks', icon: 'FolderCheck', label: '班级任务' },
        { page: 'school-calendar', icon: 'CalendarDays', label: '校历管理' },
        { page: 'seating', icon: 'LayoutGrid', label: '座位表' },
        { page: 'groups', icon: 'Users', label: '小组管理' },
        { page: 'dormitories', icon: 'LayoutGrid', label: '宿舍管理' },
        { page: 'duty', icon: 'CheckCircle', label: '值日安排' },
        { page: 'meetings', icon: 'Presentation', label: '班会记录' },
        { page: 'activities', icon: 'CalendarDays', label: '班级活动' },
        { page: 'fund', icon: 'DollarSign', label: '班费管理' }
      ] },
      { title: '总结与档案', items: [
        { page: 'comments', icon: 'Pencil', label: '评语管理' },
        { page: 'reports', icon: 'FileText', label: '报告与学期档案' },
        { page: 'diary', icon: 'FileText', label: '班主任日志' },
        { page: 'recycle', icon: 'Trash2', label: '数据恢复' }
      ] }
    ]
  }
]
