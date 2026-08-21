import type { FastifyInstance, FastifyReply } from 'fastify';

import * as parentReplyDrafter from '../../agent/parentReplyDrafter.js';
import { ParentReplyError } from '../../services/parentReply.js';
import { ArchivedScopeError, ScopeError } from '../../services/context.js';

interface ParentReplyBody {
  student_id?: number;
  parent_message?: string;
  teacher_context?: string;
  reply_goal?: string;
  teacher_role?: string;
  feedback_deadline?: string;
  owner?: string;
  tone?: string;
}
function mapError(reply: FastifyReply, error: unknown): FastifyReply | undefined {
  if (error instanceof ArchivedScopeError) return reply.status(409).send({ detail: error.message });
  if (error instanceof ScopeError) return reply.status(404).send({ detail: error.message });
  if (error instanceof ParentReplyError) return reply.status(400).send({ detail: error.message });
  return undefined;
}

export function registerParentReplyRoutes(app: FastifyInstance): void {
  app.post('/api/parent-reply/generate', async (request, reply) => {
    try {
      const body = request.body as ParentReplyBody;
      return await parentReplyDrafter.generateParentReplyDraft({
        studentId: Number(body.student_id ?? 0),
        parentMessage: String(body.parent_message ?? ''),
        teacherContext: body.teacher_context,
        replyGoal: body.reply_goal,
        teacherRole: body.teacher_role,
        feedbackDeadline: body.feedback_deadline,
        owner: body.owner,
        tone: body.tone,
      });
    } catch (error) {
      const mapped = mapError(reply, error);
      if (mapped) return mapped;
      throw error;
    }
  });
}
