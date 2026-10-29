/**
 * Last-chance cleanup for test resources that outlive a test by design — a
 * persistent tmux pane with a scratch overlay under it, a fixture mount — when
 * the test process ends before its own `finally` runs: the run is interrupted
 * (SIGINT / SIGTERM, which is how vitest tears a pool worker down on abort) or
 * the process exits with work still registered.
 *
 * Callbacks run SYNCHRONOUSLY, once, newest first, each isolated from the
 * others' failures. A signal is re-raised with the default action afterwards,
 * so the process still terminates exactly as it would have.
 *
 * Boundary: SIGKILL cannot be intercepted. A run killed that way leaves what
 * it left before; run mount-heavy work through test/helpers/private-mount-ns.ts
 * (namespaced, dies with the process) where the test can afford it.
 */
const pending = new Set<() => void>();
let installed = false;

function runAll(): void {
  for (const fn of [...pending].reverse()) {
    pending.delete(fn);
    try { fn(); } catch { /* best effort: never block the others */ }
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  process.once('exit', runAll);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const onSignal = (): void => {
      runAll();
      process.removeListener(signal, onSignal);
      // Someone else handles this signal too (and got this delivery): leave
      // the outcome to them. Otherwise restore the default: terminate.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

/** Register `fn`; call the returned function once the test cleaned up itself. */
export function onTestProcessExit(fn: () => void): () => void {
  install();
  pending.add(fn);
  return () => { pending.delete(fn); };
}
