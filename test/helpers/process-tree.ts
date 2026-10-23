/**
 * Kill a spawned child together with everything still running below it.
 *
 * SIGKILL takes down only the process it is sent to. A worker killed in the
 * middle of a synchronous `tmux …` call leaves that client running — and when
 * the test then deletes the worker's private TMUX_TMPDIR, a client that has not
 * resolved its socket yet falls back to /tmp, i.e. the HOST's tmux servers
 * (the tmux fence refuses it and fails the file: #2214). So the whole tree goes
 * down before the caller removes anything that tree uses.
 *
 * The child is stopped first, so it cannot fork while its tree is read; every
 * descendant found is stopped too, until a read finds nothing new. Only then
 * does SIGKILL go to all of them. A daemon that already left the tree (a tmux
 * server double-forks away from the client that started it) is not touched, so
 * a test can kill a worker and keep the pane it created.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';

function childrenByParent(): Map<number, number[]> {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const byParent = new Map<number, number[]>();
  for (const line of (out.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    const list = byParent.get(ppid);
    if (list) list.push(pid);
    else byParent.set(ppid, [pid]);
  }
  return byParent;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/** Every process below `root` that is in the tree now. */
function descendantPids(root: number): number[] {
  const byParent = childrenByParent();
  const found: number[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift()!;
    found.push(pid);
    queue.push(...(byParent.get(pid) ?? []));
  }
  return found;
}

/** Stop `child` and its descendants, SIGKILL all of them, and wait (bounded)
 *  for `child` to exit. No-op for a child that has already exited. */
export async function killProcessTree(child: ChildProcess, waitMs = 2_000): Promise<void> {
  const root = child.pid;
  if (!root || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  const tree = new Set<number>([root]);
  signal(root, 'SIGSTOP');
  for (;;) {
    const fresh = descendantPids(root).filter(pid => !tree.has(pid));
    if (fresh.length === 0) break;
    for (const pid of fresh) {
      tree.add(pid);
      signal(pid, 'SIGSTOP');
    }
  }
  for (const pid of tree) signal(pid, 'SIGKILL');
  await Promise.race([exited, new Promise(done => setTimeout(done, waitMs))]);
}
