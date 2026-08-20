import { OWNER_TYPES, listEvidence } from '../../services/evidence.js';
import { ToolError, ToolDefinition } from '../toolRegistry.js';

const ALL_CHANNELS = ['web', 'wechat', 'local', 'lan'];

function evidenceList(args: Record<string, unknown>): Record<string, unknown> {
  const ownerType = String(args['owner_type'] ?? '').trim();
  const ownerId = Number(args['owner_id'] ?? 0);
  if (!OWNER_TYPES.has(ownerType)) {
    throw new ToolError(`不支持的凭证归属类型：${ownerType}`, { code: 'invalid_arguments', retryable: true });
  }
  if (!ownerId || !Number.isFinite(ownerId)) {
    throw new ToolError('owner_id 必须是正整数', { code: 'invalid_arguments', retryable: true });
  }
  const rows = listEvidence({ ownerType, ownerId });
  const kindCounts: Record<string, number> = {};
  const dates: string[] = [];
  for (const row of rows) {
    const kind = String(row.evidence_kind ?? '');
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    const createdAt = String(row.created_at ?? '').slice(0, 10);
    if (createdAt && !dates.includes(createdAt)) dates.push(createdAt);
  }
  return {
    owner_type: ownerType,
    owner_id: ownerId,
    total_count: rows.length,
    kind_counts: kindCounts,
    date_range: dates.length > 0 ? { earliest: dates[0], latest: dates[dates.length - 1] } : null,
    items: rows.map((row) => ({
      id: row.id,
      evidence_kind: row.evidence_kind,
      original_name: row.original_name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      source_channel: row.source_channel,
      note: row.note,
      created_at: row.created_at,
    })),
  };
}

export function buildEvidenceTools(): ToolDefinition[] {
  return [
    new ToolDefinition({
      name: 'evidence_list',
      description: '查询指定归属记录的凭证/附件元数据列表，返回数量、类型分布和日期范围，不返回图片数据。用于了解某条考勤或沟通记录有哪些凭证附件。',
      parameters: {
        type: 'object',
        properties: {
          owner_type: { type: 'string', enum: [...OWNER_TYPES], description: '凭证归属类型' },
          owner_id: { type: 'integer', minimum: 1, description: '归属记录 ID' },
        },
        required: ['owner_type', 'owner_id'],
        additionalProperties: false,
      },
      handler: evidenceList,
      readOnly: true,
      sensitive: false,
      allowChannels: ALL_CHANNELS,
    }),
  ];
}
