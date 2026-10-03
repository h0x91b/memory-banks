# Flue 2.1.0 documentation — index

Generated from each page's front matter (`title`, `description`). Provenance and license: [README.md](README.md).

## guide

- [Agent Hooks](guide/agent-hooks.md) — Compose an agent's capabilities — model, tools, skills, state, and lifecycle — with Flue's hook primitives.
- [Agents](guide/building-agents.md) — Create an agent, configure its capabilities, and send it messages over time.
- [Channels](guide/channels.md) — Receive verified provider events into agent conversations, and reply through the provider's own SDK.
- [Cloudflare](guide/cloudflare-target.md) — Understand the Cloudflare-specific runtime behavior and APIs for Flue applications.
- [Database](guide/database.md) — Configure where Flue durably stores agent conversations, from the in-memory default to SQLite, Postgres, and beyond.
- [Deploy](guide/deploy.md) — Build your Flue application into a deployable artifact and ship it to the Node.js or Cloudflare target.
- [Durability](guide/durability.md) — The accepted-work contract — what survives crashes, restarts, and redeploys, and how interrupted agent work recovers.
- [Evals](guide/evals.md) — Test agent behavior by running an agent against a live model and asserting on what it does.
- [Getting Started](guide/getting-started.mdx) — Set up a Flue project automatically or create your first agent manually.
- [MCP](guide/mcp.md) — Connect agents to remote MCP servers and mount their tools.
- [Migration Guide](guide/migration.md) — Upgrade an application from Flue 1.0.0-beta.x to v2.0.0 — build, routing, agents, tools, workflows, SDK, and deployment.
- [Models](guide/models.md) — Choose, tune, and connect the LLM that powers your agent with the useModel hook.
- [Node.js](guide/node-target.md) — Understand the Node.js-specific runtime behavior and APIs for Flue applications.
- [Observability](guide/observability.md) — Observe agent activity through the runtime event stream — model turns, tool calls, logs, and token usage — and export it to your observability stack.
- [Project Layout](guide/project-layout.md) — Understand the source files and generated output in a Flue project.
- [React](guide/react.md) — Build React interfaces for live agent conversations.
- [Routing](guide/routing.md) — Mount agents, channels, and custom routes explicitly in app.ts.
- [Sandboxes](guide/sandboxes.md) — Give your agent a workspace — the filesystem and shell where it reads, writes, and runs commands.
- [Schedules](guide/schedules.md) — Deliver input to your agents on a cron schedule, on Node.js and Cloudflare.
- [Skills](guide/skills.md) — Teach agents reusable expertise with progressively disclosed instructions and supporting files.
- [Subagents](guide/subagents.md) — Delegate focused work to isolated child agents with useSubagent, defineSubagent, and the built-in GeneralSubagent.
- [Tools](guide/tools.md) — Give agents the ability to call your application code and act on external systems.
- [Why Flue?](guide/why-flue.md) — Build autonomous AI agents with a programmable TypeScript harness, and run them anywhere.
- [Workflows](guide/workflows.md) — Driving agents from programs — one-shot CLI runs and CI jobs, standalone scripts, the SDK, and durable workflows.

## reference

- [Agent API](reference/agent-api.md) — The agent module contract and the programmatic surface around agents — agent functions, statics, dispatch(), init(), start(), HTTP routing, the harness, the defineTool/defineSkill/defineSubagent resource helpers, and signal narration.
- [Agent Behavior](reference/agent-behavior.md) — How an agent behaves when you run it — the default tools, environment, message handling, context rules, and limits, in one place.
- [Agent Hooks API](reference/agent-hooks-api.md) — Every hook callable during an agent render — useModel through the event hooks — and the render contract that governs them.
- [Configuration](reference/configuration.md) — Reference for the flue.config file, the flue() Vite plugin and its option merging, target detection, and how vite dev, vite build, and flue run resolve configuration.
- [Data Persistence API](reference/data-persistence-api.md) — The persistence adapter contract — PersistenceAdapter, the three store interfaces, the cross-cutting storage rules, and the contract test suites.
- [Errors Reference](reference/errors.md) — The FlueError hierarchy, stable error type codes, the HTTP error envelope, settlement errors, and error classification on live observations.
- [Events Reference](reference/events.md) — The runtime event vocabulary — the observe() and instrument() registration contracts, the event envelope, every event type and its payload, and the live-only observation fields.
- [Provider API](reference/provider-api.md) — Reference for the providers config, setProvider(), model resolution, and the Cloudflare AI binding provider in @flue/runtime.
- [Sandbox Adapter API](reference/sandbox-api.md) — The contract for building a sandbox adapter — SandboxFactory, Sandbox, SandboxDriver, the adapter tool factory, and the built-in sandbox factories.
- [Streaming Protocol](reference/streaming-protocol.md) — The HTTP wire protocol for agent conversation reads and writes.

## sdk

- [createFlueClient(...)](sdk/create-flue-client.md) — Constructing a Flue Agent SDK client — URL semantics, fetch override, headers, and token.
- [Errors](sdk/errors.md) — The Flue Agent SDK error classes, the HTTP error envelope, and how to discriminate failures.
- [Events](sdk/events.md) — How the Flue Agent SDK event and conversation types map to their reference pages, plus the SDK-owned event stream and redelivery semantics.
- [FlueClient](sdk/flue-client.md) — The Flue Agent SDK conversation client — send(), read(), wait(), abort(), history(), observe(), and attachmentUrl().
- [Flue Agent SDK](sdk/overview.md) — The Flue Agent SDK (@flue/sdk) — installation, a minimal round trip, the HTTP surface it wraps, and a map of the SDK reference pages.

## cli

- [flue add](cli/add.md) — Reference for fetching blueprint implementation guides.
- [flue docs](cli/docs.md) — Browse the documentation bundled with the Flue CLI — list every page, print one as markdown, or search the full text.
- [flue init](cli/init.md) — Reference for scaffolding a new Flue project, interactively or with flags.
- [CLI](cli/overview.md) — The flue command-line interface — invocation, command catalog, global flags, and exit codes.
- [flue run](cli/run.md) — Reference for running one agent module locally, transport-free, from the command line.
- [flue update](cli/update.md) — Reference for fetching a blueprint guide that brings an existing integration up to the current version.

## ecosystem

- [Discord](ecosystem/channels/discord.md) — Receive verified Discord interactions and use a project-owned REST client.
- [GitHub](ecosystem/channels/github.md) — Receive signed GitHub webhooks and use Octokit from application-owned tools.
- [Google Chat](ecosystem/channels/google-chat.md) — Receive authenticated Google Chat interactions and Workspace Events with a project-owned REST client.
- [Intercom](ecosystem/channels/intercom.md) — Receive verified Intercom notifications and use a workspace-bound official client from application-owned tools.
- [Linear](ecosystem/channels/linear.md) — Receive verified Linear resource and agent-session webhooks with a project-owned SDK client.
- [Facebook Messenger](ecosystem/channels/messenger.md) — Receive verified Messenger Page events with a project-owned Graph API client.
- [Notion](ecosystem/channels/notion.md) — Receive signed Notion webhook events and use the official client from application-owned tools.
- [Resend](ecosystem/channels/resend.md) — Receive verified Resend webhooks and retrieve inbound email through the official client.
- [Salesforce Marketing Cloud](ecosystem/channels/salesforce-marketing-cloud.md) — Receive verified Marketing Cloud Engagement ENS batches and compose a tenant-bound Fetch client.
- [Shopify](ecosystem/channels/shopify.md) — Receive verified Shopify webhooks and use a shop-bound Admin GraphQL client from application-owned tools.
- [Slack](ecosystem/channels/slack.md) — Receive verified Slack events and use the Slack Web API from application code.
- [Stripe](ecosystem/channels/stripe.md) — Receive verified Stripe webhooks and use the official SDK from application-owned tools.
- [Microsoft Teams](ecosystem/channels/teams.md) — Receive authenticated Teams activities and use a project-owned Bot Connector client.
- [Telegram](ecosystem/channels/telegram.md) — Receive verified Telegram Bot API Updates with a project-owned grammY client.
- [Twilio](ecosystem/channels/twilio.md) — Receive verified Twilio SMS and MMS webhooks with a project-owned Fetch client.
- [WhatsApp](ecosystem/channels/whatsapp.md) — Receive verified WhatsApp Business Cloud deliveries with a project-owned Fetch client.
- [Zendesk](ecosystem/channels/zendesk.md) — Receive verified Zendesk events and use a ticket-bound Fetch client from application-owned tools.
- [libSQL](ecosystem/databases/libsql.md) — Give Flue agents durable state with libSQL — a local SQLite file, a self-hosted libSQL server, or an embedded replica.
- [MongoDB](ecosystem/databases/mongodb.md) — Give Flue agents durable, shared state with MongoDB.
- [MySQL](ecosystem/databases/mysql.md) — Give Flue agents durable, shared state with MySQL 8 and InnoDB.
- [Postgres](ecosystem/databases/postgres.md) — Give Flue agents durable, shared state with a Postgres database.
- [Redis](ecosystem/databases/redis.md) — Give Flue agents durable, shared state with Redis.
- [Supabase](ecosystem/databases/supabase.md) — Give Flue agents durable, shared state with Supabase Postgres.
- [Turso](ecosystem/databases/turso.md) — Give Flue agents durable, hosted state with Turso — managed, replicated libSQL.
- [Valkey](ecosystem/databases/valkey.md) — Give Flue agents durable, shared state with Valkey.
- [Deploy Agents on AWS](ecosystem/deploy/aws.md) — Run the Flue Docker image on AWS — ECS Express Mode, EC2, or ECS on Fargate — with managed Postgres for durable state.
- [Deploy to Cloudflare](ecosystem/deploy/cloudflare.md) — Build and deploy Flue agents on Cloudflare Workers with Vite.
- [Deploy Agents with Docker](ecosystem/deploy/docker.md) — Package the Flue Node.js build as a portable container image.
- [Deploy Agents on Fly.io](ecosystem/deploy/fly.md) — Deploy Flue agents to Fly.io as a long-running Docker app on Fly Machines.
- [Build Agents for GitHub Actions](ecosystem/deploy/github-actions.md) — Build and run Flue agents in GitHub Actions.
- [Build Agents for GitLab CI/CD](ecosystem/deploy/gitlab-ci.md) — Build and run Flue agents in GitLab CI/CD pipelines.
- [Deploy Agents on Node.js](ecosystem/deploy/node.md) — Build and deploy Flue agents as a Node.js server with Vite.
- [Deploy Agents on Railway](ecosystem/deploy/railway.md) — Run the Flue Node server as a long-running Railway service.
- [Deploy Agents on Render](ecosystem/deploy/render.md) — Run the Flue Node server as a long-running Render web service.
- [Deploy Agents on SST](ecosystem/deploy/sst.md) — Deploy Flue agents to AWS with SST as a long-running Fargate container service.
- [boxd](ecosystem/sandboxes/boxd.md) — Connect a Flue agent to an application-owned boxd Linux VM.
- [Cloudflare Computer](ecosystem/sandboxes/cloudflare-computer.md) — Give agents a durable Cloudflare workspace with a real shell.
- [Cloudflare Sandbox](ecosystem/sandboxes/cloudflare.mdx) — Run Flue agent work inside Cloudflare container-backed sandboxes.
- [Daytona](ecosystem/sandboxes/daytona.md) — Connect a Flue agent to an application-owned Daytona sandbox.
- [E2B](ecosystem/sandboxes/e2b.md) — Connect a Flue agent to an E2B Linux sandbox.
- [exe.dev](ecosystem/sandboxes/exedev.md) — Connect a Node-target Flue application to an exe.dev VM over SSH.
- [islo](ecosystem/sandboxes/islo.md) — Connect a Node-target Flue application to a named islo sandbox through its CLI.
- [Mirage](ecosystem/sandboxes/mirage.md) — Connect Flue agents to Mirage workspaces and mounted resources.
- [Modal](ecosystem/sandboxes/modal.md) — Connect a Flue agent to an application-owned Modal Sandbox.
- [Vercel Sandbox](ecosystem/sandboxes/vercel.md) — Connect a Flue agent to an application-owned Vercel Sandbox environment.
- [Braintrust](ecosystem/tooling/braintrust.md) — Trace Flue agent operations, model turns, tools, tasks, and compactions in Braintrust.
- [Jetty](ecosystem/tooling/jetty.md) — Grade Flue agent output and compare results across versions with Jetty.
- [OpenTelemetry](ecosystem/tooling/opentelemetry.md) — Export Flue agents, model calls, and tools with OpenTelemetry GenAI semantics.
- [Sentry](ecosystem/tooling/sentry.md) — Send Flue errors, logs, and AI traces to Sentry on Node.js and Cloudflare.
- [Vitest Evals](ecosystem/tooling/vitest-evals.md) — Add repeatable agent evals to a Flue project with vitest-evals.
