/**
 * Fixed-grid font fitting of the web terminal page.
 *
 * An adopted pane (or a managed Herdr follower) pins xterm to the remote grid.
 * The page then shrinks its font until the whole row fits the container, never
 * above the normal auto size and never below the readable minimum, so a 213-col
 * Herdr pane on a desktop browser no longer gets a horizontal scrollbar.
 *
 * The page script lives inside worker.ts's template string; cut out the real
 * functions and run them against a stubbed xterm whose cell width is quantized
 * like Chromium's (measured: 14px→8, 12px→7, 11.5px→6.5, 9px→5 at DPR 2).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function slice(fromMarker: string, lastFunction: string): string {
  const start = source.indexOf(fromMarker);
  const last = source.indexOf(lastFunction, start);
  const end = source.indexOf('\n}', last);
  if (start < 0 || last < 0 || end < 0) throw new Error(`page script not found: ${fromMarker}`);
  return source.slice(start, end + 2);
}

const sizerScript = slice('var _WB_FONT_MIN=', 'function _wbTerminalWidth(){');
const applyScript = slice('function _wbApplyAutoFontSize(){', 'function _wbFixedGridFontSize(base){');

const MEASURED_CELL: Record<number, number> = {
  14: 8, 13.5: 8, 13: 7.5, 12.5: 7.5, 12: 7, 11.5: 6.5, 11: 6.5, 10.5: 6, 10: 6, 9.5: 5.5, 9: 5,
};

interface Page {
  apply(): boolean;
  term: { cols: number; options: { fontSize: number } };
  setFixed(fixed: boolean): void;
  host: { clientWidth: number };
}

function boot(opts: { width: number; cols: number; fontSize?: number; fixed: boolean; measurable?: boolean }): Page {
  const host = { clientWidth: opts.width };
  const options = { fontSize: opts.fontSize ?? 14 };
  const term = {
    cols: opts.cols,
    options,
    _core: {
      _renderService: {
        get dimensions() {
          return { css: { cell: { width: opts.measurable === false ? 0 : MEASURED_CELL[options.fontSize] } } };
        },
      },
    },
  };
  const state = { fixedSize: opts.fixed };
  const run = new Function(
    'document', 'window', 'term', 'state',
    `${sizerScript}
${applyScript}
return function(){ fixedSize = state.fixedSize; return _wbApplyAutoFontSize(); };
var fixedSize;`,
  )({ getElementById: (id: string) => (id === 'terminal' ? host : null) }, { innerWidth: opts.width }, term, state);
  return {
    apply: run,
    term,
    host,
    setFixed(fixed) { state.fixedSize = fixed; },
  };
}

function rowWidth(page: Page): number {
  return MEASURED_CELL[page.term.options.fontSize] * page.term.cols;
}

describe('fixed-grid font fitting', () => {
  it('keeps the auto font when the pinned grid already fits', () => {
    const page = boot({ width: 1920, cols: 213, fixed: true });
    expect(page.apply()).toBe(false);
    expect(page.term.options.fontSize).toBe(14);
    expect(rowWidth(page) + 15).toBeLessThanOrEqual(1920);
  });

  it('shrinks until the whole row fits, re-checking the quantized cell width', () => {
    // The linear estimate from 14px lands on 12px, whose real row is 1506px.
    const page = boot({ width: 1500, cols: 213, fixed: true });
    expect(page.apply()).toBe(true);
    expect(page.term.options.fontSize).toBe(11.5);
    expect(rowWidth(page) + 15).toBeLessThanOrEqual(1500);
  });

  it('stops at the readable minimum when even that cannot fit', () => {
    const page = boot({ width: 1000, cols: 213, fixed: true });
    page.apply();
    expect(page.term.options.fontSize).toBe(9);
    expect(rowWidth(page) + 15).toBeGreaterThan(1000);
  });

  it('never grows above the auto size of a narrow container', () => {
    const page = boot({ width: 1500, cols: 80, fixed: true });
    page.apply();
    expect(page.term.options.fontSize).toBe(14);
  });

  it('returns to the auto font after leaving the fixed grid', () => {
    const page = boot({ width: 1500, cols: 213, fixed: true });
    page.apply();
    expect(page.term.options.fontSize).toBe(11.5);
    page.setFixed(false);
    expect(page.apply()).toBe(true);
    expect(page.term.options.fontSize).toBe(14);
  });

  it('leaves an owned grid on the plain auto font', () => {
    const page = boot({ width: 1500, cols: 213, fixed: false });
    expect(page.apply()).toBe(false);
    expect(page.term.options.fontSize).toBe(14);
  });

  it('falls back to the auto font when xterm has not measured a cell yet', () => {
    const page = boot({ width: 1500, cols: 213, fixed: true, measurable: false });
    expect(page.apply()).toBe(false);
    expect(page.term.options.fontSize).toBe(14);
  });
});
