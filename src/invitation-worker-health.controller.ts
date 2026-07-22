import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { InvitationWorkerHealthService } from './invitation-worker-health.service';

@Controller('health')
export class InvitationWorkerHealthController {
  constructor(private readonly health: InvitationWorkerHealthService) {}

  @Get()
  async get(@Res() response: Response): Promise<void> {
    const status = await this.health.status();
    response.status(status.healthy ? 200 : 503).json(status);
  }
}
