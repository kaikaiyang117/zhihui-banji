/* 统计路由：仪表盘 / 考勤 / 成绩 / 积分 / 班费（与 backend/app/routers/stats.py 对应）。 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import * as attendance from '../../services/attendance.js';
import * as scores from '../../services/scores.js';
import * as points from '../../services/points.js';
import * as funds from '../../services/funds.js';
import * as statsService from '../../services/stats.js';

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof statsService.StatsError) {
    return reply.status(400).send({ detail: (error as Error).message });
  }
  if (error instanceof attendance.AttendanceError) {
    return reply.status(400).send({ detail: (error as Error).message });
  }
  if (error instanceof scores.ScoreError) {
    return reply.status(400).send({ detail: (error as Error).message });
  }
  return undefined;
}

function wrap(reply: FastifyReply, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    const mapped = mapError(reply, error);
    if (mapped) return mapped;
    throw error;
  }
}

export function registerStatsRoutes(app: FastifyInstance): void {
  app.get('/api/stats/calendar', async (request, reply) => {
    const { month = '' } = request.query as { month?: string };
    return wrap(reply, () => statsService.calendar({ month }));
  });

  app.get('/api/stats/dashboard', async (request, reply) => {
    const { date } = request.query as { date?: string };
    return wrap(reply, () => statsService.dashboard(date));
  });

  app.get('/api/stats/attendance', async (request, reply) => {
    const { date_from = '', date_to = '', scene = '全部场景' } = request.query as {
      date_from?: string; date_to?: string; scene?: string;
    };
    return wrap(reply, () => attendance.attendanceStats({ dateFrom: date_from, dateTo: date_to, scene }));
  });

  app.get('/api/stats/scores', async () => scores.scoreSummary());

  app.get('/api/stats/points', async () => points.classSummary());

  app.get('/api/stats/fund', async () => funds.classSummary());
}
