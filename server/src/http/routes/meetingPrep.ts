import type { FastifyInstance, FastifyReply } from 'fastify';

import * as meetingPrepDrafter from '../../agent/meetingPrepDrafter.js';
import * as meetingPrep from '../../services/meetingPrep.js';

interface MeetingPrepBody {
  student_id?: number;
  date_start?: string;
  date_end?: string;
  include_scores?: boolean;
  include_attendance?: boolean;
  include_points?: boolean;
  include_communications?: boolean;
  include_events?: boolean;
  include_health?: boolean;
  purpose?: string;
  teacher_notes?: string;
}

function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof meetingPrep.MeetingPrepError) {
    const message = String(error.message);
    return reply.status(/不存在/.test(message) ? 404 : 400).send({ detail: message });
  }
  if (error instanceof meetingPrepDrafter.MeetingPrepAIDraftError) {
    return reply.status(400).send({ detail: error.message });
  }
  return undefined;
}

function summaryOptions(body: MeetingPrepBody): meetingPrep.MeetingPrepSummaryOptions {
  return {
    studentId: Number(body.student_id ?? 0),
    dateStart: body.date_start,
    dateEnd: body.date_end,
    includeScores: body.include_scores,
    includeAttendance: body.include_attendance,
    includePoints: body.include_points,
    includeCommunications: body.include_communications,
    includeEvents: body.include_events,
    includeHealth: body.include_health,
  };
}

export function registerMeetingPrepRoutes(app: FastifyInstance): void {
  app.post('/api/meeting-prep/summary', async (request, reply) => {
    try {
      return meetingPrep.generateStudentSummary(summaryOptions(request.body as MeetingPrepBody));
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post('/api/meeting-prep/outline', async (request, reply) => {
    try {
      const body = request.body as MeetingPrepBody;
      const summary = meetingPrep.generateStudentSummary(summaryOptions(body));
      const result = await meetingPrepDrafter.generateMeetingPlan({
        summary,
        purpose: String(body.purpose ?? ''),
        teacherNotes: body.teacher_notes,
      });
      return { ...result, summary, outline: result.plan.outline };
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
