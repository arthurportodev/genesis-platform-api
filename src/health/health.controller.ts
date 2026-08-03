import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { HealthResponse, HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async compatibilityReadiness(): Promise<HealthResponse> {
    return this.ready();
  }

  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): HealthResponse {
    return this.requireAvailable(this.healthService.checkLiveness());
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<HealthResponse> {
    return this.requireAvailable(await this.healthService.checkReadiness());
  }

  private requireAvailable(result: HealthResponse): HealthResponse {
    if (result.status === 'unavailable') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return result;
  }
}
