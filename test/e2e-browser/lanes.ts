/**
 * Feishu lane selection. Every cases/*.yaml file is one lane, run as the
 * Midscene project `feishu-<file stem>`. FEISHU_E2E_CASES picks lanes:
 * unset/`core` = core-*.yaml (the CI gate), `all` = every lane, or a comma list
 * of lane stems (`core-codex,full-group`).
 *
 * scripts/midscene-report-evidence.mjs mirrors this for the report scripts
 * (they are plain .mjs and cannot import TypeScript);
 * test/midscene-lanes.test.ts keeps the two in step.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

export const CASES_DIR = path.join(import.meta.dirname, 'cases');

export function laneStem(file: string): string {
  return path.basename(file).replace(/\.ya?ml$/i, '');
}

export function laneProject(file: string): string {
  return `feishu-${laneStem(file)}`;
}

export function listLaneFiles(dir = CASES_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
}

export function selectLaneFiles(files: readonly string[], selection?: string): string[] {
  const value = selection?.trim() || 'core';
  if (value === 'all') return [...files];
  if (value === 'core') return files.filter((file) => laneStem(file).startsWith('core-'));
  const wanted = value.split(',').map((stem) => stem.trim()).filter(Boolean);
  const unknown = wanted.filter((stem) => !files.some((file) => laneStem(file) === stem));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown FEISHU_E2E_CASES lane(s): ${unknown.join(', ')}. ` +
        `Known: core, all, ${files.map(laneStem).join(', ')}`,
    );
  }
  return files.filter((file) => wanted.includes(laneStem(file)));
}
