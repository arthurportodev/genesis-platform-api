import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RuntimeHealthStateService } from './runtime-health-state.service';

export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

const READINESS_TIMEOUT_MS = 1_500;

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly runtimeState: RuntimeHealthStateService,
  ) {}

  checkLiveness(): HealthResponse {
    return { status: this.runtimeState.isLive() ? 'ok' : 'unavailable' };
  }

  async checkReadiness(): Promise<HealthResponse> {
    if (!this.runtimeState.isReady()) return { status: 'unavailable' };
    try {
      await Promise.race([
        this.dataSource.query('SELECT 1'),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('readiness timeout')),
            READINESS_TIMEOUT_MS,
          ).unref();
        }),
      ]);
    } catch {
      return { status: 'unavailable' };
    }
    return { status: 'ok' };
  }
}
