import {
  Injectable,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';

export type RuntimeHealthState = 'starting' | 'ready' | 'draining' | 'stopped';

@Injectable()
export class RuntimeHealthStateService
  implements OnModuleDestroy, OnApplicationShutdown
{
  private state: RuntimeHealthState = 'starting';

  isLive(): boolean {
    return this.state !== 'stopped';
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  markReady(): void {
    if (this.state === 'starting') this.state = 'ready';
  }

  beginDraining(): void {
    if (this.state === 'starting' || this.state === 'ready') {
      this.state = 'draining';
    }
  }

  onModuleDestroy(): void {
    this.beginDraining();
  }

  onApplicationShutdown(): void {
    this.beginDraining();
    if (this.state === 'draining') this.state = 'stopped';
  }
}
