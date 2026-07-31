import {
  Injectable,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { writeStructuredLog } from '../common/logging/structured-logger';

type RuntimeState = 'starting' | 'ready' | 'draining' | 'stopped';

@Injectable()
export class RuntimeHealthStateService
  implements OnModuleDestroy, OnApplicationShutdown
{
  private state: RuntimeState = 'starting';

  isLive(): boolean {
    return this.state !== 'stopped';
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  markReady(): void {
    if (this.state !== 'starting') return;
    this.state = 'ready';
    writeStructuredLog('log', { event: 'runtime.ready' });
  }

  beginDraining(signal?: string): void {
    if (this.state === 'draining' || this.state === 'stopped') return;
    this.state = 'draining';
    writeStructuredLog('log', { event: 'runtime.draining', signal });
  }

  onModuleDestroy(): void {
    this.beginDraining();
  }

  onApplicationShutdown(signal?: string): void {
    this.state = 'stopped';
    writeStructuredLog('log', { event: 'runtime.stopped', signal });
  }
}
