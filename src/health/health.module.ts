import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { RuntimeHealthStateService } from './runtime-health-state.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService, RuntimeHealthStateService],
  exports: [HealthService, RuntimeHealthStateService],
})
export class HealthModule {}
