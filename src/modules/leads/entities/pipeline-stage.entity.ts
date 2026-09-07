import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Pipeline } from './pipeline.entity';

@Entity({ name: 'pipeline_stages' })
@Index('UQ_pipeline_stages_id_organization', ['id', 'organizationId'], {
  unique: true,
})
@Index(
  'UQ_pipeline_stages_id_organization_pipeline',
  ['id', 'organizationId', 'pipelineId'],
  { unique: true },
)
export class PipelineStage {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ name: 'pipeline_id', type: 'uuid' }) pipelineId!: string;
  @Column({ type: 'varchar', length: 120 }) name!: string;
  @Column({ type: 'integer' }) position!: number;
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => Pipeline, (pipeline) => pipeline.stages, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn([
    { name: 'pipeline_id', referencedColumnName: 'id' },
    { name: 'organization_id', referencedColumnName: 'organizationId' },
  ])
  pipeline!: Pipeline;
}
