import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PipelineParamsDto {
  @IsUUID('4')
  pipelineId!: string;
}

export class PipelineStageParamsDto extends PipelineParamsDto {
  @IsUUID('4')
  stageId!: string;
}

export class PipelineStageInputDto {
  @IsUUID('4')
  id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class CreatePipelineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((stage: PipelineStageInputDto) => stage.id)
  @ValidateNested({ each: true })
  @Type(() => PipelineStageInputDto)
  stages!: PipelineStageInputDto[];
}

export class RenamePipelineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;
}

export class CreatePipelineStageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class RenamePipelineStageDto extends CreatePipelineStageDto {}

export class ReorderPipelineStagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  stageIds!: string[];
}

export class DynamicKanbanDto {
  @IsOptional()
  @IsUUID('4')
  pipelineStageId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}
