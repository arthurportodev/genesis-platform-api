import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/app.config';

export interface HealthResponse {
  status: 'ok' | 'error';
  service: string;
  version: string;
  database: 'connected' | 'disconnected';
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async check(): Promise<HealthResponse> {
    const app = this.configService.getOrThrow<AppConfig>('app');
    let database: HealthResponse['database'] = 'connected';

    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      database = 'disconnected';
    }

    return {
      status: database === 'connected' ? 'ok' : 'error',
      service: 'genesis-platform-api',
      version: app.version,
      database,
      timestamp: new Date().toISOString(),
    };
  }
}
