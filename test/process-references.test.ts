import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLiveProcessReferences } from '../src/utils/process-references.js';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-proc-refs-'));
  roots.push(root);
  return root;
}

/** A fake /proc entry: the probe only reads cmdline, environ and cwd. */
function fakeProcess(proc: string, pid: string, entry: { argv?: string[]; env?: string[]; cwd?: string }): void {
  const dir = join(proc, pid);
  mkdirSync(dir, { recursive: true });
  if (entry.argv) writeFileSync(join(dir, 'cmdline'), `${entry.argv.join('\0')}\0`);
  if (entry.env) writeFileSync(join(dir, 'environ'), `${entry.env.join('\0')}\0`);
  if (entry.cwd) symlinkSync(entry.cwd, join(dir, 'cwd'));
}

describe('findLiveProcessReferences', () => {
  it('finds a path in argv, in the start environment, or as cwd', () => {
    const proc = tempRoot();
    fakeProcess(proc, '101', { argv: ['bwrap', '--ro-bind', '/tmp/bmcp-0-aaaa', '/run/botmux-mcp'] });
    fakeProcess(proc, '102', { argv: ['claude'], env: ['TMPDIR=/scratch/p/k1', 'HOME=/root'] });
    fakeProcess(proc, '103', { argv: ['sh'], cwd: '/scratch/p/k2/build' });
    fakeProcess(proc, '104', { argv: ['sh'], cwd: '/scratch/p/k3x' });
    mkdirSync(join(proc, 'self'));

    const found = findLiveProcessReferences(
      ['bmcp-0-aaaa', '/scratch/p/k1', '/scratch/p/k2', '/scratch/p/k3', '/scratch/p/unused'],
      proc,
    );

    expect([...(found ?? [])].sort()).toEqual(['/scratch/p/k1', '/scratch/p/k2', 'bmcp-0-aaaa']);
  });

  it('answers "cannot tell" when there is no process table to read', () => {
    expect(findLiveProcessReferences(['/x'], join(tempRoot(), 'missing'))).toBeNull();
  });

  it.runIf(process.platform === 'linux')('sees a real process that runs with TMPDIR and cwd in the directory', async () => {
    const scratch = tempRoot();
    const other = tempRoot();
    const child = spawn('sleep', ['30'], { cwd: scratch, env: { ...process.env, TMPDIR: scratch }, stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });

    const found = findLiveProcessReferences([scratch, other]);

    expect(found?.has(scratch)).toBe(true);
    expect(found?.has(other)).toBe(false);
  });
});
