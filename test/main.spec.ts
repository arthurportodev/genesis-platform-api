import { NestExpressApplication } from '@nestjs/platform-express';
import {
  configureShutdownHooks,
  createShutdownSignalHandler,
  SHUTDOWN_TIMEOUT_MS,
  ShutdownDeadlineDependencies,
} from '../src/main';
import { RuntimeHealthStateService } from '../src/health/runtime-health-state.service';

jest.mock('../src/app.module', () => ({ AppModule: class AppModule {} }));

describe('main graceful shutdown coordination', () => {
  const deadline = {} as ReturnType<typeof setTimeout>;

  function createDependencies(): {
    dependencies: ShutdownDeadlineDependencies;
    setTimer: jest.MockedFunction<ShutdownDeadlineDependencies['setTimer']>;
    clearTimer: jest.MockedFunction<ShutdownDeadlineDependencies['clearTimer']>;
    onExit: jest.MockedFunction<ShutdownDeadlineDependencies['onExit']>;
    exit: jest.MockedFunction<(code: number) => void>;
    writeTimeout: jest.MockedFunction<
      ShutdownDeadlineDependencies['writeTimeout']
    >;
    getExitListener: () => () => void;
    getTimeout: () => () => void;
  } {
    let exitListener: (() => void) | undefined;
    let timeout: (() => void) | undefined;
    const setTimer: jest.MockedFunction<
      ShutdownDeadlineDependencies['setTimer']
    > = jest.fn((callback, timeoutMs) => {
      void timeoutMs;
      timeout = callback;
      return deadline;
    });
    const clearTimer: jest.MockedFunction<
      ShutdownDeadlineDependencies['clearTimer']
    > = jest.fn();
    const onExit: jest.MockedFunction<ShutdownDeadlineDependencies['onExit']> =
      jest.fn((listener) => {
        exitListener = listener;
      });
    const exit = jest.fn((code: number) => {
      void code;
    });
    const writeTimeout: jest.MockedFunction<
      ShutdownDeadlineDependencies['writeTimeout']
    > = jest.fn();
    return {
      dependencies: {
        setTimer,
        clearTimer,
        onExit,
        exit: exit as unknown as (code: number) => never,
        writeTimeout,
      },
      setTimer,
      clearTimer,
      onExit,
      exit,
      writeTimeout,
      getExitListener: () => {
        if (exitListener === undefined) throw new Error('exit not registered');
        return exitListener;
      },
      getTimeout: () => {
        if (timeout === undefined) throw new Error('timeout not registered');
        return timeout;
      },
    };
  }

  it('uses the Nest success exit only after its shutdown lifecycle', () => {
    const enableShutdownHooks = jest.fn();
    const app = {
      enableShutdownHooks,
    } as unknown as NestExpressApplication;

    configureShutdownHooks(app);

    expect(enableShutdownHooks).toHaveBeenCalledWith(['SIGTERM', 'SIGINT'], {
      useProcessExit: true,
    });
  });

  it('starts one deadline and one draining transition across repeated signals', () => {
    const beginDraining = jest.fn();
    const runtimeState = {
      beginDraining,
    } as unknown as RuntimeHealthStateService;
    const { dependencies, setTimer, clearTimer, onExit, getExitListener } =
      createDependencies();
    const handleSignal = createShutdownSignalHandler(
      runtimeState,
      dependencies,
    );

    handleSignal('SIGTERM');
    handleSignal('SIGINT');

    expect(beginDraining).toHaveBeenCalledTimes(1);
    expect(beginDraining).toHaveBeenCalledWith('SIGTERM');
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      SHUTDOWN_TIMEOUT_MS,
    );
    expect(onExit).toHaveBeenCalledTimes(1);

    getExitListener()();
    expect(clearTimer).toHaveBeenCalledWith(deadline);
  });

  it('keeps a real non-zero timeout path visible', () => {
    const beginDraining = jest.fn();
    const runtimeState = {
      beginDraining,
    } as unknown as RuntimeHealthStateService;
    const { dependencies, exit, writeTimeout, getTimeout } =
      createDependencies();
    const handleSignal = createShutdownSignalHandler(
      runtimeState,
      dependencies,
    );

    handleSignal('SIGTERM');
    getTimeout()();

    expect(writeTimeout).toHaveBeenCalledWith('SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
