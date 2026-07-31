import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { HealthResponse, HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async compatibilityReadiness(): Promise<HealthResponse> {
    return this.ready();
  }

  @Get('live')
  live(): HealthResponse {
    const result = this.healthService.checkLiveness();

    if (result.status === 'unavailable') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return result;
  }

  @Get('ready')
  async ready(): Promise<HealthResponse> {
    const result = await this.healthService.checkReadiness();

    if (result.status === 'unavailable') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return result;
  }
}
