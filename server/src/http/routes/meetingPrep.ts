import type { FastifyInstance, FastifyReply } from 'fastify';

import * as meetingPrep from '../../services/meetingPrep.js';

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    if (error instanceof meetingPrep.MeetingPrepError) {
      const msg = String(error.message);
      const status = /不存在/.test(msg) ? 404 : 400;
      return reply.status(status).send({ detail: msg });
    }
    throw error;
  }
}

export function registerMeetingPrepRoutes(app: FastifyInstance): void {
  app.post('/api/meeting-prep/summary', async (request, reply) => {
    const body = request.body as {
      student_id?: number;
      date_start?: string;
      date_end?: string;
      include_scores?: boolean;
      include_attendance?: boolean;
      include_points?: boolean;
      include_communications?: boolean;
      include_events?: boolean;
      include_health?: boolean;
    };
    return wrap(reply, () => meetingPrep.generateStudentSummary({
      studentId: Number(body.student_id ?? 0),
      dateStart: body.date_start,
      dateEnd: body.date_end,
      includeScores: body.include_scores,
      includeAttendance: body.include_attendance,
      includePoints: body.include_points,
      includeCommunications: body.include_communications,
      includeEvents: body.include_events,
      includeHealth: body.include_health,
    }));
  });

  app.post('/api/meeting-prep/outline', async (request, reply) => {
    const body = request.body as {
      student_id?: number;
      date_start?: string;
      date_end?: string;
      categories?: string[];
    };
    return wrap(reply, () => {
      const summary = meetingPrep.generateStudentSummary({
        studentId: Number(body.student_id ?? 0),
        dateStart: body.date_start,
        dateEnd: body.date_end,
        includeScores: !body.categories || body.categories.includes('scores'),
        includeAttendance: !body.categories || body.categories.includes('attendance'),
        includePoints: !body.categories || body.categories.includes('points'),
        includeCommunications: !body.categories || body.categories.includes('communications'),
        includeEvents: !body.categories || body.categories.includes('events'),
        includeHealth: body.categories?.includes('health') ?? false,
      });
      const lines: string[] = [];
      lines.push(`# 会谈准备提纲`);
      lines.push('');
      lines.push(`学生：${summary.student['姓名'] ?? '未知'}`);
      lines.push(`日期范围：${summary.date_range.start || '未指定'} ~ ${summary.date_range.end || '未指定'}`);
      lines.push('');
      for (const section of summary.sections) {
        lines.push(`## ${section.category}`);
        lines.push(`来源：${section.source} | 时间：${section.date_range || '全部'}`);
        if (!section.has_data) {
          lines.push('暂无记录');
        } else {
          for (const item of section.items) {
            if (item.summary) {
              lines.push(`- ${item.summary}`);
            } else if (item.date) {
              lines.push(`- ${item.date} | ${item.status ?? item.event_type ?? item.method ?? ''} ${item.reason ?? item.description ?? ''}`);
            } else if (item.exam_name) {
              lines.push(`- ${item.exam_date} ${item.exam_name} ${item.subject ?? ''} ${item.score ?? ''}${item.rank ? ` (排名${item.rank})` : ''}`);
            } else {
              lines.push(`- ${Object.values(item).join(' ')}`);
            }
          }
        }
        lines.push('');
      }
      lines.push('---');
      lines.push('以上为事实数据摘要，请教师根据实际情况编辑提纲。');
      return { outline: lines.join('\n'), student: summary.student, date_range: summary.date_range };
    });
  });
}
