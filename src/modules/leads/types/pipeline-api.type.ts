import { LeadListItem } from './lead-api.type';

export interface PipelineStageView {
  id: string;
  name: string;
  position: number;
  archivedAt: string | null;
}

export interface PipelineView {
  id: string;
  name: string;
  isDefault: boolean;
  revision: string;
  createdAt: string;
  updatedAt: string;
  stages: PipelineStageView[];
}

export interface PipelineMutationResult {
  pipeline: PipelineView;
  replayed: boolean;
}

export interface DynamicKanbanColumn {
  stage: Pick<PipelineStageView, 'id' | 'name' | 'position'>;
  total: number;
  expectedValueTotalMinor: string;
  withoutExpectedValue: number;
  items: LeadListItem[];
  page: { nextCursor: string | null; limit: number };
}

export interface DynamicKanbanResponse {
  pipeline: Pick<PipelineView, 'id' | 'name' | 'isDefault' | 'revision'>;
  currency: 'BRL';
  expectedValueTotalMinor: string;
  withoutExpectedValue: number;
  columns: DynamicKanbanColumn[];
}
