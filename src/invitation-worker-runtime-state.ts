import { Injectable } from '@nestjs/common';

@Injectable()
export class InvitationWorkerRuntimeState {
  static readonly HEARTBEAT_TTL_MS = 30_000;
  private heartbeatAt = 0;
  private fatal = false;

  heartbeat(): void {
    this.heartbeatAt = Date.now();
  }

  markFatal(): void {
    this.fatal = true;
  }

  isHealthy(now = Date.now()): boolean {
    return (
      !this.fatal &&
      this.heartbeatAt > 0 &&
      now - this.heartbeatAt <= InvitationWorkerRuntimeState.HEARTBEAT_TTL_MS
    );
  }
}
