import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RuntimeHealthStateService } from './runtime-health-state.service';

export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

export const READINESS_TIMEOUT_MS = 1_500;

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
      await this.queryDatabaseWithinDeadline();
    } catch {
      return { status: 'unavailable' };
    }

    return { status: this.runtimeState.isReady() ? 'ok' : 'unavailable' };
  }

  private queryDatabaseWithinDeadline(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Readiness deadline exceeded')),
        READINESS_TIMEOUT_MS,
      );

      void this.dataSource.query('SELECT 1').then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error('Query failed'));
        },
      );
    });
  }
}
