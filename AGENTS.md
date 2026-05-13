# AGENTS.md

Minimal Flue starter project. One webhook agent that says hello, routed through OpenRouter → DeepSeek v4 Flash → NovitaAI.

## Layout

- `.flue/agents/<name>.ts` — agent source (e.g. `hello.ts`)
- `.flue/roles/` — role markdowns (currently empty)
- `scripts/flue-run.sh` — wrapper that falls back to `$OPENROUTER_FLUE` if `.env` lacks `OPENROUTER_API_KEY`
- `dist/` — output of `flue build` (gitignored)
- `.env` — secrets (gitignored). Copy from `.env.example`

Flue auto-discovers `.flue/agents/*.ts`. Adding a new file is enough — no registration needed.

## Commands

```bash
npm run dev               # flue dev --target node, port 3583, hot reload
npm run hello -- '{"name":"Arseny"}'   # one-shot CLI run, no server
npm run build             # production bundle to dist/
npm run start             # node dist/server.mjs (after build)
npm run typecheck         # tsc --noEmit
```

For local dev hit the agent at `POST http://localhost:3583/agents/<name>/<id>`.

## Key facts (learned the hard way)

- **Package name**: SDK is `@flue/sdk`, NOT `@flue/runtime` (the on-main README is out of date). Import types from `'@flue/sdk'`.
- **Model**: `openrouter/deepseek/deepseek-v4-flash`. Flue's model registry is at https://flueframework.com/models.json.
- **NovitaAI routing**: OpenRouter's provider routing is set via the request-body `provider: { order: ['novita'] }` field. Flue's `configureProvider()` only exposes `baseUrl/headers/apiKey`, so this can't be pinned in code today. Workaround: set provider preferences for this model in your OpenRouter account dashboard.
- **API key fallback**: `npm run dev` / `npm run hello` go through `scripts/flue-run.sh`, which exports `OPENROUTER_API_KEY=$OPENROUTER_FLUE` only if `.env` doesn't already define the key. `.env` wins; shell `$OPENROUTER_FLUE` is the fallback.
- **Cost/usage**: `session.prompt()` returns `{ data, usage, model }`. `usage` includes `input/output/cacheRead/cacheWrite/totalTokens` and `cost.{input,output,cacheRead,cacheWrite,total}` in USD — already computed by the SDK against the active model's cost table. No need to call OpenRouter `/generation` separately.

## Docs

- Homepage: https://flueframework.com/
- README (main): https://github.com/withastro/flue/blob/main/README.md
- Node.js deploy guide: https://github.com/withastro/flue/blob/main/docs/deploy-node.md
- Other deploy guides (Cloudflare, GitHub Actions, GitLab, Render): https://github.com/withastro/flue/tree/main/docs
- Models list: https://flueframework.com/models.json
- Skill (this project was scaffolded from): https://flueframework.com/start.md

## When extending

- New agent: drop `.flue/agents/<name>.ts` with `export const triggers = { webhook: true }` and a default async function `({ init, payload }: FlueContext) => ...`.
- New role (subagent persona): drop `.flue/roles/<name>.md` with frontmatter `description:` + body, then `prompt(..., { role: '<name>' })`.
- Custom skills: `.agents/skills/<name>/SKILL.md` — see deploy-node guide.
- Persistence on Node: in-memory by default; pass a `persist` store to `init()` for durable sessions.
