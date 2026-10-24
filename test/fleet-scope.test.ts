/**
 * The fleet supervisor must not keep the cgroup of whoever ran `botmux
 * start/restart`: started from inside a bot session it lived in that session's
 * systemd scope, so the session's own close / CLI restart (which stops its
 * scope) would SIGKILL every daemon and worker with it.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { moveSupervisorIntoFleetScope, type FleetScopeRuntime } from '../src/core/fleet-scope.js';
import { userSystemdBusEnv } from '../src/core/session-scope.js';
import { readProcessSystemdUnit } from '../src/utils/systemd-unit.js';
import { tsRunnerPrefix, tsEvalArgs } from './helpers/ts-runner.js';

function runtime(unit: string, over: Partial<FleetScopeRuntime> = {}) {
  let current = unit;
  const run = vi.fn((_command: string, args: readonly string[]) => {
    current = args[7];  // StartTransientUnit's unit name argument
    return { status: 0, stderr: '' };
  });
  return {
    rt: {
      platform: 'linux' as const,
      pid: 4242,
      readUnit: () => current,
      busEnv: () => ({ XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' }),
      run,
      now: () => 1_000_000,
      sleepMs: () => {},
      ...over,
    } satisfies Partial<FleetScopeRuntime>,
    run,
  };
}

describe('moveSupervisorIntoFleetScope', () => {
  it.each([
    'botmux-session-fc17c9ee-fa8f-46f4-93cc-58c7ac288696.scope',
    'session-12.scope',
  ])('moves a supervisor started inside %s into its own fleet scope', unit => {
    const { rt, run } = runtime(unit);
    const outcome = moveSupervisorIntoFleetScope(rt);
    expect(outcome).toMatchObject({ action: 'moved', from: unit });
    expect(outcome.action === 'moved' && outcome.to).toMatch(/^botmux-fleet-[a-z0-9]+-4242\.scope$/);
    const [command, args] = run.mock.calls[0];
    expect(command).toBe('busctl');
    expect(args.slice(0, 7)).toEqual(['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))']);
    expect(args).toEqual(expect.arrayContaining(['PIDs', 'au', '1', '4242']));
  });

  it.each(['botmux.service', 'botmux-watchdog.service', 'botmux-fleet-k3x9-77.scope'])(
    'keeps a supervisor that already runs in the fleet unit %s', unit => {
      const { rt, run } = runtime(unit);
      expect(moveSupervisorIntoFleetScope(rt)).toEqual({ action: 'kept', unit });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('starts where it is when the move is impossible or fails', () => {
    const noBus = runtime('session-3.scope', { busEnv: () => undefined });
    expect(moveSupervisorIntoFleetScope(noBus.rt).action).toBe('unsupported');
    expect(noBus.run).not.toHaveBeenCalled();

    const refused = runtime('session-3.scope', { run: vi.fn(() => ({ status: 1, stderr: 'Access denied' })) });
    expect(moveSupervisorIntoFleetScope(refused.rt)).toMatchObject({ action: 'failed', unit: 'session-3.scope', reason: 'Access denied' });

    const notMoved = runtime('session-3.scope', { run: vi.fn(() => ({ status: 0, stderr: '' })) });
    expect(moveSupervisorIntoFleetScope(notMoved.rt)).toMatchObject({ action: 'failed', unit: 'session-3.scope' });

    expect(moveSupervisorIntoFleetScope({ ...runtime('session-3.scope').rt, platform: 'darwin' }).action).toBe('unsupported');
  });
});

describe('readProcessSystemdUnit', () => {
  it.runIf(process.platform === 'linux')('reads the unit leaf from cgroup v1 and v2 membership', () => {
    const v1 = '12:memory:/user.slice\n1:name=systemd:/user.slice/user-0.slice/user@0.service/app.slice/botmux-session-ab.scope\n0::/user.slice\n';
    expect(readProcessSystemdUnit(77, () => v1)).toBe('botmux-session-ab.scope');
    const v2 = '0::/user.slice/user-0.slice/session-4.scope\n';
    expect(readProcessSystemdUnit(77, () => v2)).toBe('session-4.scope');
    expect(readProcessSystemdUnit(77, () => { throw new Error('ENOENT'); })).toBeUndefined();
  });
});

describe.runIf(process.platform === 'linux' && !!userSystemdBusEnv())('against the real user systemd manager', () => {
  it('a process started inside another unit really moves itself into its own fleet scope', async () => {
    // The child (spawned by this test, so it starts in this test's cgroup)
    // runs the real move on its own pid and reports where it ended up.
    const { command, prefixArgs } = tsRunnerPrefix();
    const { args } = tsEvalArgs(`
      const { moveSupervisorIntoFleetScope } = await import(${JSON.stringify(new URL('../src/core/fleet-scope.ts', import.meta.url).pathname)});
      const { readProcessSystemdUnit } = await import(${JSON.stringify(new URL('../src/utils/systemd-unit.ts', import.meta.url).pathname)});
      const before = readProcessSystemdUnit(process.pid);
      const outcome = moveSupervisorIntoFleetScope();
      console.log(JSON.stringify({ before, outcome, after: readProcessSystemdUnit(process.pid) }));
    `);
    const child = spawn(command, [...prefixArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    await new Promise(resolve => child.once('exit', resolve));
    const report = JSON.parse(out.trim().split('\n').pop()!);
    if (report.outcome.action === 'kept') return; // this test already runs in a fleet unit
    expect(report.outcome.action).toBe('moved');
    expect(report.after).toBe(report.outcome.to);
    expect(report.after).not.toBe(report.before);
  });
});
