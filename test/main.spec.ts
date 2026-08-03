import { NestExpressApplication } from '@nestjs/platform-express';
import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';
import {
  configureShutdownHooks,
  createShutdownSignalHandler,
  SHUTDOWN_TIMEOUT_MS,
  ShutdownDeadlineDependencies,
} from '../src/main';

jest.mock('../src/app.module', () => ({ AppModule: class AppModule {} }));

describe('main graceful shutdown coordination', () => {
  const deadline = {} as ReturnType<typeof setTimeout>;

  it('exits explicitly after Nest shutdown hooks complete', () => {
    const enableShutdownHooks = jest.fn();
    const app = { enableShutdownHooks } as unknown as NestExpressApplication;

    configureShutdownHooks(app);

    expect(enableShutdownHooks).toHaveBeenCalledWith(['SIGTERM', 'SIGINT'], {
      useProcessExit: true,
    });
  });

  it('starts one draining transition and one deadline for repeated signals', () => {
    const beginDraining = jest.fn();
    const runtime = { beginDraining } as unknown as RuntimeHealthStateService;
    const harness = createDeadlineHarness();
    const handleSignal = createShutdownSignalHandler(
      runtime,
      harness.dependencies,
    );

    handleSignal('SIGTERM');
    handleSignal('SIGINT');

    expect(beginDraining).toHaveBeenCalledTimes(1);
    expect(harness.setTimer).toHaveBeenCalledTimes(1);
    expect(harness.setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      SHUTDOWN_TIMEOUT_MS,
    );
    expect(harness.onExit).toHaveBeenCalledTimes(1);

    harness.exitListener();
    expect(harness.clearTimer).toHaveBeenCalledWith(deadline);
  });

  it('uses a non-zero exit without terminating the test process on timeout', () => {
    const runtime = {
      beginDraining: jest.fn(),
    } as unknown as RuntimeHealthStateService;
    const harness = createDeadlineHarness();
    const handleSignal = createShutdownSignalHandler(
      runtime,
      harness.dependencies,
    );

    handleSignal('SIGTERM');
    harness.timeout();

    expect(harness.logTimeout).toHaveBeenCalledWith('SIGTERM');
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  function createDeadlineHarness(): {
    dependencies: ShutdownDeadlineDependencies;
    setTimer: jest.Mock;
    clearTimer: jest.Mock;
    onExit: jest.Mock;
    exit: jest.Mock;
    logTimeout: jest.Mock;
    timeout: () => void;
    exitListener: () => void;
  } {
    let timeout: (() => void) | undefined;
    let exitListener: (() => void) | undefined;
    const setTimer = jest.fn((callback: () => void) => {
      timeout = callback;
      return deadline;
    });
    const clearTimer = jest.fn();
    const onExit = jest.fn((listener: () => void) => {
      exitListener = listener;
    });
    const exit = jest.fn();
    const logTimeout = jest.fn();

    return {
      dependencies: {
        setTimer,
        clearTimer,
        onExit,
        exit: exit as unknown as (code: number) => never,
        logTimeout,
      },
      setTimer,
      clearTimer,
      onExit,
      exit,
      logTimeout,
      timeout: () => {
        if (timeout === undefined) throw new Error('timeout not registered');
        timeout();
      },
      exitListener: () => {
        if (exitListener === undefined) {
          throw new Error('exit listener not registered');
        }
        exitListener();
      },
    };
  }
});
