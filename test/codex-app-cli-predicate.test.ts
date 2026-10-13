import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCodexAppCliId, isCodexFamilyCliId } from '../src/adapters/cli/types.js';

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

describe('isCodexAppCliId / isCodexFamilyCliId', () => {
  it('only recognizes the codex-app id (and tolerates absent ids)', () => {
    expect(isCodexAppCliId('codex-app')).toBe(true);
    expect(isCodexAppCliId('codex')).toBe(false);
    expect(isCodexAppCliId('claude-code')).toBe(false);
    expect(isCodexAppCliId(undefined)).toBe(false);
    expect(isCodexAppCliId(null)).toBe(false);
  });

  it('codex family = codex + codex-app, nothing else (traex shares the rollout shape but not CODEX_HOME)', () => {
    expect(isCodexFamilyCliId('codex')).toBe(true);
    expect(isCodexFamilyCliId('codex-app')).toBe(true);
    expect(isCodexFamilyCliId('traex')).toBe(false);
    expect(isCodexFamilyCliId(undefined)).toBe(false);
  });
});

describe('codex-app judgement lives behind the predicate in daemon / worker-pool / worker', () => {
  // 判定点一律走 isCodexAppCliId / isCodexFamilyCliId。字面量只允许出现在「赋值 / 拼接 id」里，
  // 不允许再次出现 `=== 'codex-app'` / `!== 'codex-app'` 形式的散落比较。
  const COMPARE = /[!=]==\s*'codex-app'/;
  for (const rel of ['src/worker.ts', 'src/core/worker-pool.ts', 'src/daemon.ts']) {
    it(`${rel} has no raw codex-app comparison`, () => {
      const offenders = read(rel)
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => COMPARE.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
      expect(offenders.map(o => `${rel}:${o.n}: ${o.line.trim()}`)).toEqual([]);
    });
  }

  it('managed-origin validation keeps the deliberate OR of both cliId sources (fail-closed)', () => {
    // worker 侧：worker 当前 init 的 cliId 与会话库里的 cliId 任一为 Codex App 即按 ledger 精确校验。
    const worker = read('src/worker.ts');
    expect(worker).toMatch(/isCodexAppCliId\(lastInitConfig\?\.cliId\)\s*\|\|\s*isCodexAppCliId\(session\?\.cliId\)/);
    // daemon 侧两处（/api/send 与 hook 路径）：initConfig.cliId 与 session.cliId 同理。
    const daemon = read('src/daemon.ts');
    const hits = daemon.match(/isCodexAppCliId\(ds!?\.initConfig\?\.cliId\) \|\| isCodexAppCliId\(ds!?\.session\.cliId\)/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  it('the dispatch-ledger gates that predate cliLaunchSnapshot keep their (session ?? bot) priority', () => {
    // 这三处刻意不含 cliLaunchSnapshot（snapshot pending 期间会与 sessionCliId 不一致，属已登记的疑似漂移）。
    // 若有人把它们改成 sessionCliId，是行为变化，需同步更新重构说明与这条断言。
    const pool = read('src/core/worker-pool.ts');
    expect(pool).toContain('isCodexAppCliId(ds.session.cliId ?? getBot(ds.larkAppId).config.cliId)');
    expect(pool).toMatch(/const effectiveCliId = ds\.session\.cliId \?\? botCfg\.cliId;\s*\n\s*return isCodexAppCliId\(effectiveCliId\)/);
    expect(pool).toMatch(/const effectiveCliId = ds\.session\.cliId \?\? botCfg\.cliId;\s*\n\s*if \(!isCodexAppCliId\(effectiveCliId\) \|\| !turnId\) return undefined;/);
    // 含 snapshot 的完整优先级：消息通道里的 effectiveCliId。
    expect(pool).toContain('const effectiveCliId = sessionCliId(ds, botCfg);');
  });
});
