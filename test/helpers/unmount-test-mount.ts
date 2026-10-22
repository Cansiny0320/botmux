import { spawnSync } from 'node:child_process';
import { mountsAtOrUnder } from '../../src/adapters/backend/sandbox.js';

/**
 * Take a test mount down; returns whether nothing is mounted at or below
 * `target` any more — read from the mount table, exactly what the sandbox
 * removal guards look at.
 *
 * A plain unmount can be refused while something still holds the filesystem
 * (EBUSY); the same call a moment later succeeds. A case that unmounts and then
 * asserts a sweep or teardown reclaimed the tree would see that refusal only as
 * "not reclaimed". So, like the production unmountAny, fall back to a lazy
 * detach (FUSE: `fusermount -u -z`, kernel mounts: `umount -l`), which takes the
 * mount out of the table at once whatever still holds it.
 */
export function unmountTestMount(target: string): boolean {
  const attempts: Array<[string, string[]]> = [
    ['umount', [target]],
    ['fusermount', ['-u', target]],
    ['fusermount', ['-u', '-z', target]],
    ['umount', ['-l', target]],
  ];
  for (const [command, args] of attempts) {
    if (mountsAtOrUnder(target)?.length === 0) return true;
    spawnSync(command, args, { stdio: 'ignore' });
  }
  return mountsAtOrUnder(target)?.length === 0;
}
