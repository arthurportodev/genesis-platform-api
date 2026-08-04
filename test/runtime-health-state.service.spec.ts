import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';

describe('RuntimeHealthStateService', () => {
  it('moves monotonically from starting to ready, draining and stopped', () => {
    const runtime = new RuntimeHealthStateService();
    expect(runtime.isLive()).toBe(true);
    expect(runtime.isReady()).toBe(false);

    runtime.markReady();
    expect(runtime.isReady()).toBe(true);

    runtime.beginDraining();
    expect(runtime.isLive()).toBe(true);
    expect(runtime.isReady()).toBe(false);

    runtime.onApplicationShutdown();
    expect(runtime.isLive()).toBe(false);
    expect(runtime.isReady()).toBe(false);
  });

  it('makes draining idempotent and never returns to ready', () => {
    const runtime = new RuntimeHealthStateService();
    runtime.markReady();
    runtime.beginDraining();
    runtime.beginDraining();
    runtime.markReady();

    expect(runtime.isLive()).toBe(true);
    expect(runtime.isReady()).toBe(false);
  });

  it('drains before stopping even when startup did not finish', () => {
    const runtime = new RuntimeHealthStateService();
    runtime.onApplicationShutdown();
    runtime.markReady();

    expect(runtime.isLive()).toBe(false);
    expect(runtime.isReady()).toBe(false);
  });
});
