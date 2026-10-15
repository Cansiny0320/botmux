import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { handleAgentProfilesApi, type AgentProfilesApiDeps } from '../src/dashboard/agent-profiles-api.js';

let dir: string;
let agentsPath: string;
let server: Server;
let base: string;
let deps: Partial<AgentProfilesApiDeps>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-agents-api-'));
  agentsPath = join(dir, 'agents.json');
  deps = {};
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleAgentProfilesApi(req, res, url, {
      canManageHost: true,
      knownBotIds: () => new Set(['cli_a', 'cli_b']),
      agentsPath: () => agentsPath,
      checkWorkingDir: dirPath => (dirPath === '/missing' ? 'not found' : null),
      now: () => 1_000,
      ...deps,
    }).then(handled => {
      if (!handled) { res.writeHead(599); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

const agent = { name: '主仓库 Claude', exec: { cliId: 'claude-code', model: '', reasoningEffort: '' } };

describe('/api/agents', () => {
  it('returns an empty snapshot before agents.json exists and ignores unrelated paths', async () => {
    expect(await call('GET', '/api/agents')).toEqual({ status: 200, body: { ok: true, agents: [], links: {} } });
    expect((await call('GET', '/api/agentsx')).status).toBe(599);
  });

  it('creates an agent, optionally linking bots, and persists it privately', async () => {
    const created = await call('POST', '/api/agents', { agent, linkBots: ['cli_a', 'cli_a'] });
    expect(created.status).toBe(200);
    const id = created.body.agent.id;
    expect(id).toMatch(/^ag_/);
    expect(created.body.agent).toMatchObject({ name: '主仓库 Claude', createdAt: 1_000, updatedAt: 1_000 });
    expect(created.body.links).toEqual({ cli_a: id });
    const onDisk = JSON.parse(readFileSync(agentsPath, 'utf-8'));
    expect(onDisk).toMatchObject({ version: 1, links: { cli_a: id } });
    expect(statSync(agentsPath).mode & 0o777).toBe(0o600);
  });

  it('validates the CLI selection key, effort/model pairing and working dir', async () => {
    expect((await call('POST', '/api/agents', { agent: { name: 'x', exec: { cliId: 'nope' } } })).body.error).toBe('exec:invalid_cli');
    expect((await call('POST', '/api/agents', {
      agent: { name: 'x', exec: { cliId: 'codex', model: 'unknown-model', reasoningEffort: 'ultra' } },
    })).body.error).toBe('exec:reasoning_effort_not_supported_by_model');
    const missingDir = await call('POST', '/api/agents', { agent: { name: 'x', workspace: { mode: 'default', workingDir: '/missing' } } });
    expect(missingDir).toMatchObject({ status: 400, body: { error: 'workspace:invalid_working_dir', message: 'not found' } });
    expect((await call('POST', '/api/agents', { agent, linkBots: ['cli_unknown'] })).status).toBe(404);
  });

  it('accepts a Claude config profile only for a CLI that supports it, and only if it exists', async () => {
    const ok = await call('POST', '/api/agents', { agent: { name: 'api', exec: { cliId: 'claude-code', configDir: '~/.claude-api' } } });
    expect(ok.body.agent.exec).toMatchObject({ cliId: 'claude-code', configDir: '~/.claude-api' });
    expect((await call('POST', '/api/agents', { agent: { name: 'x', exec: { cliId: 'codex', configDir: '~/.claude-api' } } })).body.error)
      .toBe('exec:config_dir_unsupported');
    expect((await call('POST', '/api/agents', { agent: { name: 'x', exec: { cliId: 'claude-code', configDir: '/missing' } } })).body)
      .toMatchObject({ error: 'exec:invalid_config_dir', message: 'not found' });
  });

  it('updates the definition while keeping id and createdAt', async () => {
    const id = (await call('POST', '/api/agents', { agent })).body.agent.id;
    deps.now = () => 2_000;
    const updated = await call('PUT', `/api/agents/${id}`, { agent: { ...agent, name: '改名', sandbox: { mode: 'oncall' } } });
    expect(updated.body.agent).toMatchObject({ id, name: '改名', sandbox: { mode: 'oncall' }, createdAt: 1_000, updatedAt: 2_000 });
    expect((await call('PUT', '/api/agents/ag_missing1', { agent })).status).toBe(404);
  });

  it('links, re-links and unlinks without touching other bots', async () => {
    const a = (await call('POST', '/api/agents', { agent })).body.agent.id;
    const b = (await call('POST', '/api/agents', { agent: { ...agent, name: 'B' } })).body.agent.id;
    expect((await call('PUT', `/api/agents/${a}/links/cli_a`)).body).toMatchObject({ previous: null, links: { cli_a: a } });
    expect((await call('PUT', `/api/agents/${a}/links/cli_b`)).body.links).toEqual({ cli_a: a, cli_b: a });
    expect((await call('PUT', `/api/agents/${b}/links/cli_a`)).body).toMatchObject({ previous: a, links: { cli_a: b, cli_b: a } });
    // 只解除确实指向该 Agent 的边：cli_a 已改关联到 b，用 a 解除不应误删。
    expect((await call('DELETE', `/api/agents/${a}/links/cli_a`)).body.links).toEqual({ cli_a: b, cli_b: a });
    expect((await call('DELETE', `/api/agents/${b}/links/cli_a`)).body.links).toEqual({ cli_b: a });
    expect((await call('PUT', `/api/agents/${a}/links/cli_unknown`)).status).toBe(404);
  });

  it('deletes an agent together with its links', async () => {
    const id = (await call('POST', '/api/agents', { agent, linkBots: ['cli_a', 'cli_b'] })).body.agent.id;
    const removed = await call('DELETE', `/api/agents/${id}`);
    expect(removed.body).toMatchObject({ ok: true, agents: [], links: {} });
    expect(removed.body.unlinked.sort()).toEqual(['cli_a', 'cli_b']);
  });

  it('hides links of bots that are no longer in bots.json', async () => {
    const id = (await call('POST', '/api/agents', { agent, linkBots: ['cli_a', 'cli_b'] })).body.agent.id;
    deps.knownBotIds = () => new Set(['cli_a']);
    expect((await call('GET', '/api/agents')).body.links).toEqual({ cli_a: id });
  });

  it('requires management rights for every write', async () => {
    deps.canManageHost = false;
    expect((await call('GET', '/api/agents')).status).toBe(200);
    expect((await call('POST', '/api/agents', { agent })).status).toBe(403);
    expect((await call('DELETE', '/api/agents/ag_whatever')).status).toBe(403);
  });

  it('refuses to overwrite a corrupt agents.json', async () => {
    writeFileSync(agentsPath, '{ not json');
    expect((await call('GET', '/api/agents')).body.error).toBe('agents_file_invalid');
    expect((await call('POST', '/api/agents', { agent })).status).toBe(500);
    expect(readFileSync(agentsPath, 'utf-8')).toBe('{ not json');
  });

  it('rejects malformed bodies', async () => {
    const response = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[' });
    expect(response.status).toBe(400);
    expect((await call('POST', '/api/agents', { agent: { name: '' } })).body.error).toBe('name_required');
  });
});

describe('/api/agents environment variables', () => {
  let revs = 0;
  let pushes: Array<{ appId: string; body: any }>;
  let daemonReply: { status: number; body: any };

  beforeEach(() => {
    revs = 0;
    pushes = [];
    daemonReply = { status: 200, body: { ok: true, env: '', envKeys: [] } };
    deps.newEnvRev = () => `rev${++revs}`;
    deps.putBotEnv = async (appId, body) => {
      pushes.push({ appId, body });
      return daemonReply;
    };
  });

  async function createWithEnv(set: Record<string, string>, linkBots: string[] = ['cli_a']) {
    const created = await call('POST', '/api/agents', { agent: { ...agent, env: { keys: [], set } }, linkBots });
    expect(created.status).toBe(200);
    return created.body.agent.id as string;
  }

  function stored(id: string) {
    return JSON.parse(readFileSync(agentsPath, 'utf-8')).agents.find((entry: any) => entry.id === id);
  }

  it('stores values in agents.json but never returns them', async () => {
    const created = await call('POST', '/api/agents', { agent: { ...agent, env: { keys: [], set: { B_TOKEN: 's3cret', A_URL: 'https://x' } } } });
    expect(created.body.agent.env).toEqual({ keys: ['A_URL', 'B_TOKEN'], rev: 'rev1', pushed: {} });
    expect(JSON.stringify(created.body)).not.toContain('s3cret');
    const listed = await call('GET', '/api/agents');
    expect(JSON.stringify(listed.body)).not.toContain('s3cret');
    expect(stored(created.body.agent.id).env.vars).toEqual({ A_URL: 'https://x', B_TOKEN: 's3cret' });
  });

  it('keeps unchanged values (and the version) on save, bumps the version when values change', async () => {
    const id = await createWithEnv({ A: '1', B: '2' });
    const same = await call('PUT', `/api/agents/${id}`, { agent: { ...agent, env: { keys: ['A', 'B'] } } });
    expect(same.body.agent.env).toMatchObject({ keys: ['A', 'B'], rev: 'rev1' });
    const changed = await call('PUT', `/api/agents/${id}`, { agent: { ...agent, env: { keys: ['A'], set: { C: '3' } } } });
    expect(changed.body.agent.env).toMatchObject({ keys: ['A', 'C'], rev: 'rev2' });
    expect(stored(id).env.vars).toEqual({ A: '1', C: '3' });
    const dropped = await call('PUT', `/api/agents/${id}`, { agent });
    expect(dropped.body.agent.env).toBeUndefined();
  });

  it('rejects reserved names and keys whose value it does not have', async () => {
    const reserved = await call('POST', '/api/agents', { agent: { ...agent, env: { keys: [], set: { BOTMUX_OWNER_OPEN_ID: 'ou_x' } } } });
    expect(reserved).toMatchObject({ status: 400, body: { error: 'env:reserved_env' } });
    const owner = await call('POST', '/api/agents', { agent: { ...agent, env: { keys: [], set: { __OWNER_OPEN_ID: 'ou_x' } } } });
    expect(owner).toMatchObject({ status: 400, body: { error: 'env:reserved_env' } });
    const id = await createWithEnv({ A: '1' });
    const unknown = await call('PUT', `/api/agents/${id}`, { agent: { ...agent, env: { keys: ['A', 'NOPE'] } } });
    expect(unknown).toMatchObject({ status: 400, body: { error: 'env:missing_value', message: 'NOPE' } });
  });

  it('pushes values by merge, removes variables the agent dropped, and records the pushed version', async () => {
    const id = await createWithEnv({ A: '1', B: '2' });
    const first = await call('PUT', `/api/agents/${id}/links/cli_a/env`);
    expect(first.status).toBe(200);
    expect(pushes).toEqual([{ appId: 'cli_a', body: { env: JSON.stringify({ A: '1', B: '2' }), mode: 'merge' } }]);
    expect(first.body.agents[0].env.pushed).toEqual({ cli_a: { rev: 'rev1', keys: ['A', 'B'] } });
    expect(JSON.stringify(first.body)).not.toContain('"1"');

    await call('PUT', `/api/agents/${id}`, { agent: { ...agent, env: { keys: ['A'] } } });
    await call('PUT', `/api/agents/${id}/links/cli_a/env`);
    // B was pushed by the agent and is no longer declared: removed. Bot-owned keys
    // never appear in a push record, so they are never in `remove`.
    expect(pushes[1]).toEqual({ appId: 'cli_a', body: { env: JSON.stringify({ A: '1' }), mode: 'merge', remove: ['B'] } });
  });

  it('leaves the record untouched and surfaces the daemon error when the push fails', async () => {
    const id = await createWithEnv({ A: '1' });
    daemonReply = { status: 400, body: { ok: false, error: 'invalid_env', reason: 'reserved_env' } };
    const failed = await call('PUT', `/api/agents/${id}/links/cli_a/env`);
    expect(failed).toMatchObject({ status: 400, body: { ok: false, error: 'invalid_env', message: 'reserved_env' } });
    expect(stored(id).env.pushed).toEqual({});
  });

  it('only pushes to a bot linked to this agent that manages env', async () => {
    const id = await createWithEnv({ A: '1' }, []);
    expect((await call('PUT', `/api/agents/${id}/links/cli_a/env`)).body.error).toBe('not_linked');
    const plain = (await call('POST', '/api/agents', { agent, linkBots: ['cli_b'] })).body.agent.id;
    expect((await call('PUT', `/api/agents/${plain}/links/cli_b/env`)).body.error).toBe('env_unmanaged');
    expect((await call('PUT', `/api/agents/${id}/links/cli_unknown/env`)).status).toBe(404);
    expect(pushes).toHaveLength(0);
  });

  it('hands pushed variables over to the bot on unlink', async () => {
    const id = await createWithEnv({ A: '1' });
    await call('PUT', `/api/agents/${id}/links/cli_a/env`);
    const unlinked = await call('DELETE', `/api/agents/${id}/links/cli_a`);
    expect(unlinked.body.agents[0].env.pushed).toEqual({});
  });

  it('removes another agent’s variables when a relinked bot syncs, and forgets that agent’s record', async () => {
    const first = await createWithEnv({ OLD: '1', SHARED: 'x' });
    await call('PUT', `/api/agents/${first}/links/cli_a/env`);
    const second = await createWithEnv({ SHARED: 'y' }, []);
    await call('PUT', `/api/agents/${second}/links/cli_a`);
    const synced = await call('PUT', `/api/agents/${second}/links/cli_a/env`);
    expect(pushes[1].body).toEqual({ env: JSON.stringify({ SHARED: 'y' }), mode: 'merge', remove: ['OLD'] });
    const byId = new Map(synced.body.agents.map((entry: any) => [entry.id, entry]));
    expect((byId.get(first) as any).env.pushed).toEqual({});
    expect((byId.get(second) as any).env.pushed).toEqual({ cli_a: { rev: 'rev2', keys: ['SHARED'] } });
  });

  it('reports 503 when the dashboard cannot reach daemons', async () => {
    const id = await createWithEnv({ A: '1' });
    deps.putBotEnv = undefined;
    expect((await call('PUT', `/api/agents/${id}/links/cli_a/env`)).status).toBe(503);
  });
});

describe('/api/agents zero injection', () => {
  it('stores the mode and rejects it up front when the unified CLI cannot support it', async () => {
    const ok = await call('POST', '/api/agents', { agent: { ...agent, promptInjection: { mode: 'none' } } });
    expect(ok.body.agent.promptInjection).toEqual({ mode: 'none' });
    const gemini = await call('POST', '/api/agents', {
      agent: { name: 'g', exec: { cliId: 'gemini', model: '', reasoningEffort: '' }, promptInjection: { mode: 'none' } },
    });
    expect(gemini).toMatchObject({ status: 400, body: { error: 'promptInjection:unsupported' } });
    const withSandbox = await call('POST', '/api/agents', {
      agent: { ...agent, sandbox: { mode: 'off' }, promptInjection: { mode: 'none' } },
    });
    expect(withSandbox.status).toBe(200);
    // Without a unified CLI each bot's daemon validates against its own CLI on push.
    const noExec = await call('POST', '/api/agents', { agent: { name: 'n', promptInjection: { mode: 'none' } } });
    expect(noExec.status).toBe(200);
    expect((await call('POST', '/api/agents', { agent: { name: 'n', promptInjection: { mode: 'off' } } })).body.error)
      .toBe('promptInjection:invalid_prompt_injection');
  });
});
