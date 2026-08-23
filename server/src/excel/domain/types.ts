export type ArtifactStatus = 'uploaded' | 'inspected' | 'expired' | 'discarded';

export type ImportPlanStatus =
  | 'draft'
  | 'needs_input'
  | 'ready'
  | 'previewed'
  | 'awaiting_confirmation'
  | 'executed'
  | 'failed'
  | 'cancelled';

export type MappingSource = 'rule' | 'ai' | 'manual';
export type MappingStatus = 'accepted' | 'needs_confirmation' | 'ignored';

export interface FieldMapping {
  sourceColumn: string;
  targetField: string | null;
  source: MappingSource;
  confidence: number;
  status: MappingStatus;
  reason?: string;
}

export interface ColumnProfile {
  header: string;
  nonEmptyCount: number;
  distinctCount: number;
  inferredType: 'empty' | 'text' | 'number' | 'date' | 'boolean' | 'mixed';
}

export interface TableRegion {
  id: string;
  range: string;
  headerRows: number[];
  headers: string[];
  rowCount: number;
  columnCount: number;
  inferredTypes: ColumnProfile[];
  confidence: number;
}

export interface WorkbookSheet {
  index: number;
  name: string;
  rowCount: number;
  columnCount: number;
  usedRange: string;
  mergedRanges: string[];
  hiddenRows: number[];
  hiddenColumns: number[];
  regions: TableRegion[];
  formulaCount: number;
}

export interface WorkbookBlueprint {
  version: 1;
  sheets: WorkbookSheet[];
  generatedAt: string;
}

export interface WorkbookArtifact {
  id: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  ownerId: string;
  channel: string;
  sessionId: string;
  classId: number;
  termId: number;
  status: ArtifactStatus;
  blueprint: WorkbookBlueprint | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface ExcelImportPlan {
  id: string;
  artifactId: string;
  adapterId: string;
  adapterVersion: string;
  sheetIndex: number;
  regionId: string;
  mappings: FieldMapping[];
  options: Record<string, unknown>;
  classId: number;
  termId: number;
  status: ImportPlanStatus;
  planHash: string;
  preview: Record<string, unknown> | null;
  previewHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactAccess {
  ownerId: string;
  channel: string;
  sessionId: string;
  classId: number;
  termId: number;
}
