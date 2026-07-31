import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';

describe('RuntimeHealthStateService', () => {
  it('moves from starting to ready, draining and stopped deterministically', () => {
    const runtime = new RuntimeHealthStateService();
    expect(runtime.isLive()).toBe(true);
    expect(runtime.isReady()).toBe(false);

    runtime.markReady();
    expect(runtime.isReady()).toBe(true);

    runtime.beginDraining('SIGTERM');
    expect(runtime.isLive()).toBe(true);
    expect(runtime.isReady()).toBe(false);

    runtime.onApplicationShutdown('SIGTERM');
    expect(runtime.isLive()).toBe(false);
    expect(runtime.isReady()).toBe(false);
  });
});
