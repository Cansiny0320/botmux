# Midscene Test · Feishu browser E2E

The existing Feishu browser scenarios are executed by `@midscene/test`. Their
Playwright and Midscene Web assertions remain in the original `*.e2e.ts` files;
the YAML cases provide native Midscene Test selection, retries, summaries, and
unified reports without changing the product behavior under test. Visible UI
operations use `aiAct`; `aiWaitFor` and `aiAssert` describe observable results,
while deterministic browser operations remain in TypeScript helpers.

## Run

Create `storageState.json` and configure the Feishu and multimodal-model values
listed in `.env.example`:

```bash
bun run test:e2e-browser:setup
bun run test:e2e-browser
```

The command writes each run below `midscene_run/runs/<run-id>/`. Use
`bun run report:dashboard` to browse historical reports.

## Lanes and parallel runs

Every `cases/*.yaml` file is a lane, run as the Midscene project
`feishu-<file stem>`. Lanes run concurrently (`FEISHU_E2E_CONCURRENCY`,
default 4); cases inside one lane run in order. A lane groups cases that must
not overlap — `full-group.yaml` stays serial because its no-mention case
asserts that no bot answered.

| Lane | Covers |
|:--|:--|
| `core-claude` | Claude private chat: new topic, streaming card, ACK reply, output toggle |
| `core-codex` | Codex private chat and prompt submission |
| `core-conversation` | Follow-up in the same topic keeps context; `/status` → `/close` → `/status` |
| `core-queue` | Three back-to-back messages are all answered |
| `full-bots` | Aiden, CoCo, OpenCode, reply smoke |
| `full-group` | Group @mention routing, group topic replies, bot collaboration |
| `full-claude-ui` | Card lifecycle, private topic mode, image/text mix, web terminal |
| `full-schedule` | Scheduled task stays in its source thread |

`FEISHU_E2E_CASES` picks lanes: unset or `core` runs the `core-*` gate,
`all` runs every lane, and a comma list selects lanes by stem:

```bash
FEISHU_E2E_CASES=core-conversation bun run test:e2e-browser
FEISHU_E2E_CASES=all FEISHU_E2E_CONCURRENCY=2 bun run test:e2e-browser
```

Parallelism stays inside one runner on purpose. Feishu delivers each app's
events to only one of its WebSocket connections, so separate jobs with their
own daemons for the same bots would receive each other's messages.

The follow-up case asks the model to repeat the first turn's ACK marker. With
`BOTMUX_MOCK_LLM=1`, the mock server (`test/helpers/mock-llm-server`) answers
from the conversation history the CLI resends. A session that lost its history
replies `RECALL MISSING` and the case fails.

Set `BOTMUX_E2E_RECORD_VIDEO=1` to record a Playwright WebM for each browser
context. Clips are written under `test/e2e-browser/midscene_run/videos/`
(gitignored) and the report index embeds them when that directory exists.
The Claude and Codex core lanes use `feishu.openAndSend`, `feishu.waitForStreamingCard`,
`feishu.waitForBotResponse`, `feishu.showStreamingOutput`, and `feishu.close`
so each phase keeps its own Midscene snapshots. Other cases use
`feishu.runScenario`.

## GitHub Actions

The `Midscene E2E` workflow runs two jobs in parallel. The Dashboard job needs
no Feishu login state, but it does need the configured Midscene visual model.
The Feishu job holds the shared live-test lock and runs the `core` lanes
concurrently. Manual runs can pick `feishu_cases` (`all` or a lane list) and
`feishu_concurrency`. A third job merges both uploads
(`botmux-midscene-dashboard-data`, `botmux-midscene-feishu-data`), publishes the
HTML report to GitHub Pages, and writes the per-case result to the workflow
Summary page. Without the live-test secrets, only the Feishu lanes are skipped;
the Dashboard run and its report are still required.

Configure these repository secrets before running the workflow:

- `FEISHU_TEST_GROUP_URL` (a direct test-group link, not the Messenger home page)
- `FEISHU_STORAGE_STATE_GZIP_BASE64` (gzip-compressed, base64-encoded `storageState.json`; plain `FEISHU_STORAGE_STATE_BASE64` is also supported)
- `MIDSCENE_MODEL_API_KEY`
- `MIDSCENE_MODEL_NAME`
- `MIDSCENE_MODEL_BASE_URL`
- `MIDSCENE_MODEL_FAMILY`
- `MIDSCENE_MODEL_REASONING_ENABLED`
- `PAGES_DEPLOY_KEY`

The stored Feishu account must be a member of the test group and have access
to the Aiden, Claude, CoCo, Codex, and OpenCode bot conversations. An unrelated
Feishu account can sign in successfully but cannot run these live cases.

The optional chat-name overrides use `FEISHU_TEST_GROUP_CHAT_NAME` and
`FEISHU_TEST_TOPIC_GROUP_NAME`. GitHub withholds repository secrets from forked
pull requests, so the live job is intentionally limited to same-repository
branches and manual runs.

Useful validation commands:

```bash
bun run test:midscene:typecheck
bun run test:midscene:nodes
```
