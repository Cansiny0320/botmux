/**
 * Worker wiring around the bridge queue's duration-marker hold, executed as
 * the real worker functions (test/helpers/worker-function-harness.ts):
 *   - the non-adopt baseline skips history without parsing it, so it must seed
 *     the queue from the transcript tail — or the first turn after every
 *     restart is settled on a block-level stop_reason again;
 *   - the Herdr idle settle keeps waiting while the head turn is held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import { transcriptShowsTurnDurationMarker, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { baselineJsonlCursor } from '../src/services/jsonl-cursor.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-dur-'));
  path = join(dir, 'session.jsonl');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const user = (uuid: string, content: string): TranscriptEvent => ({ type: 'user', uuid, message: { role: 'user', content } });
const thinkingFinal = (uuid: string): TranscriptEvent => ({
  type: 'assistant', uuid,
  message: { id: 'msg-final', role: 'assistant', content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'end_turn' },
} as TranscriptEvent);

function baselineInto(queue: BridgeTurnQueue): void {
  const bridgeAbsorbBaseline = loadWorkerFunction<() => void>('bridgeAbsorbBaseline', {
    bridgeJsonlPath: path,
    lastInitConfig: { cliId: 'claude-code' },
    bridgeQueue: queue,
    bridgeOffset: 0,
    bridgeBaselineDone: false,
    cliTranscriptEverExisted: false,
    restoreScheduledTaskAnchorsOnce: () => {},
    scanRestartInterruption: () => {},
    tryRestoreInterruptedBridgeTurns: () => false,
    baselineJsonlCursor,
    transcriptShowsTurnDurationMarker,
  });
  bridgeAbsorbBaseline();
}

describe('worker bridge baseline: duration-marker capability', () => {
  it('holds the first turn after a restart on a transcript whose history shows the marker', () => {
    appendFileSync(path, `${JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'old-d' })}\n`);
    const queue = new BridgeTurnQueue();
    baselineInto(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
  });

  it('keeps settling on the stop_reason when the history shows none', () => {
    appendFileSync(path, `${JSON.stringify({ type: 'user', uuid: 'old-u', message: { role: 'user', content: 'hi' } })}\n`);
    const queue = new BridgeTurnQueue();
    baselineInto(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true }).map(turn => turn.turnId)).toEqual(['om_turn']);
  });
});

describe('worker bridgeHeadTurnAwaitingTerminal (Herdr idle settle)', () => {
  it('keeps waiting while the head turn is held for its duration marker', () => {
    const queue = new BridgeTurnQueue();
    queue.noteDurationMarkerObserved();
    const awaiting = loadWorkerFunction<() => boolean>('bridgeHeadTurnAwaitingTerminal', {
      bridgeJsonlPath: path,
      lastInitConfig: { cliId: 'claude-code' },
      bridgeIngest: () => {},
      bridgeQueue: queue,
    });
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(awaiting()).toBe(true);
    queue.ingest([{ type: 'system', subtype: 'turn_duration', uuid: 'd1' }]);
    expect(awaiting()).toBe(false);
  });
});
