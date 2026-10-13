import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  CASES_DIR,
  laneProject,
  listLaneFiles,
  selectLaneFiles,
} from './e2e-browser/lanes.js';
import { FEISHU_SCENARIOS } from './e2e-browser/midscene-suite.js';
import { FEISHU_PHASE_SCENARIOS } from './e2e-browser/feishu-report-phases.js';
import {
  feishuLaneProject,
  isFeishuLaneProject,
  selectFeishuLaneFiles,
} from '../scripts/midscene-report-evidence.mjs';

interface LaneCase {
  name: string;
  steps: Array<Record<string, { scenario?: string }>>;
}

function laneCases(file: string): LaneCase[] {
  return (parseYaml(readFileSync(path.join(CASES_DIR, file), 'utf8')) as { cases: LaneCase[] }).cases;
}

describe('Feishu Midscene lanes', () => {
  const files = listLaneFiles();

  it('keeps the core CI gate on the conversation features', () => {
    const core = selectLaneFiles(files).map(laneProject);
    expect(core).toEqual([
      'feishu-core-claude',
      'feishu-core-codex',
      'feishu-core-conversation',
      'feishu-core-queue',
    ]);
    expect(selectLaneFiles(files, 'all')).toEqual(files);
    expect(selectLaneFiles(files, 'core-codex, full-group').map(laneProject)).toEqual([
      'feishu-core-codex',
      'feishu-full-group',
    ]);
    expect(() => selectLaneFiles(files, 'core-nope')).toThrow(/Unknown FEISHU_E2E_CASES lane/);
  });

  it('report scripts select and name lanes exactly like the Midscene config', () => {
    for (const selection of [undefined, '', 'core', 'all', 'core-claude,full-schedule']) {
      expect(selectFeishuLaneFiles(files, selection)).toEqual(selectLaneFiles(files, selection));
    }
    for (const file of files) {
      expect(feishuLaneProject(path.join(CASES_DIR, file))).toBe(laneProject(file));
      expect(isFeishuLaneProject(laneProject(file))).toBe(true);
    }
    expect(isFeishuLaneProject('dashboard-smoke')).toBe(false);
  });

  it('gives every case one lane and every step a registered scenario', () => {
    const names = files.flatMap((file) => laneCases(file).map((testCase) => testCase.name));
    // The Pages index and video manifest key evidence by case name.
    expect(new Set(names).size).toBe(names.length);
    const known = new Set<string>([...FEISHU_SCENARIOS, ...FEISHU_PHASE_SCENARIOS]);
    for (const file of files) {
      for (const testCase of laneCases(file)) {
        for (const step of testCase.steps) {
          for (const input of Object.values(step)) {
            expect(known.has(input.scenario ?? ''), `${file}: ${testCase.name}`).toBe(true);
          }
        }
      }
    }
  });
});
