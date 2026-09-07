import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PipelineStage } from './pipeline-stage.entity';

@Entity({ name: 'pipelines' })
@Index('UQ_pipelines_id_organization', ['id', 'organizationId'], {
  unique: true,
})
export class Pipeline {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @Column({ name: 'organization_id', type: 'uuid' }) organizationId!: string;
  @Column({ type: 'varchar', length: 160 }) name!: string;
  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;
  @Column({ type: 'bigint', default: 0 }) revision!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => PipelineStage, (stage) => stage.pipeline)
  stages!: PipelineStage[];
}
