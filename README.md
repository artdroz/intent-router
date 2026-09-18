# Intent Router

A service that classifies a prompt into one of a configurable set of intents, then learns
from internal/external feedback so the cheap classifiers' accuracy improves.

It has two production roles:

1. **Model-group picker for a LiteLLM auto-router.** Deployed alongside the sibling
   [`intent-router-litellm-plugin`](../intent-router-litellm-plugin) repo, it acts as a LiteLLM
   `ClassifierPlugin`: each prompt becomes a class label, which LiteLLM maps to a model group via
   `tiers`. Tenants are keyed by the LiteLLM API key hash, so per-tenant routing and learning are
   isolated. This is the primary use case.
2. **Routing step in an agent workflow.** The same service exposes an MCP server, so an agent can
   call `route_intent` and later `submit_feedback`. An agent can also create and manage its own
   gates, so a team sets up a custom taxonomy and accumulates per-tenant knowledge (learned
   embeddings, promoted keywords, veto guardrails).

The REST endpoints and the internally managed API keys are not part of the current plan. They
duplicate what LiteLLM's own auth and the MCP lane already provide, and keeping a second credential
store alive is a maintenance burden. They are preserved in the codebase for future use but are not
expected to be deployed.

## How it works

![System design](docs/assets/system-design.png)

Routing is a cascade that spends the cheapest signal first:

1. **Keyword** matching, weighted by operator-configured and feedback-promoted keywords.
2. **Semantic** search over class utterances plus learned embeddings (pgvector).
3. **LLM fallback** for prompts the cheap stages cannot decide with confidence.

A margin-and-entropy gate decides when to escalate. Online learning writes feedback back as
positive learned embeddings and negative veto guardrails, and promotes keywords via TF-IDF. An
offline LLM-as-judge pass (`scripts/internal-learning.ts`) labels routing events that never got
user feedback, so learning continues as long as the cron is setup.

## Models

Two model choices matter, and they should be different:

- **Cascade fallback (`LLM_MODEL`).** This fires on every routing event that is not confidently
  resolved by the cheap stages — in the worst case, on every request. Use a cheap, fast model; a
  local one such as Ollama `qwen2.5:7b` is fine. It only has to pick a label.
- **Judge (`JUDGE_MODEL`).** This runs offline, not on the request path, and its labels become
  training signal, so its mistakes get learned. Use a more capable, more expensive model. Cost is
  bounded by `INTERNAL_LEARNING_BUDGET`, the number of judge calls per cron run.

## Repository layout

```
config/            static configuration (default gates, DB bootstrap)
drizzle/           SQL migrations and their metadata
scripts/           operational CLI (migration, learning, tenant/key management)
docs/              architecture and API documentation
k8s/               reference Kubernetes manifests
src/
  auth/            API-key auth plus the LiteLLM service-token auth
  gates/           gate and class CRUD, default-gate seeding
  health/          liveness (/health) and readiness (/ready) endpoints
  clients/         shared upstream clients (embedding, LLM)
  mcp/             Model Context Protocol server and tools
  openai/          OpenAI-compatible chat-completions surface
  routing/         the routing pipeline
    classifiers/   keyword, semantic, and LLM classifiers
    router/        the cascading router
    judge.ts       LLM-as-judge selection and write-back
  store/           persistence (Drizzle schema and per-table modules)
```

## Configuration

Environment variables are validated at startup (see `.env.example`):

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string (needs `pgvector`) |
| `EMBED_BASE_URL` / `EMBED_MODEL` | yes | Embedding endpoint and model |
| `EMBED_DIMS` / `EMBED_API_KEY` | no | Embedding dimensions / API key |
| `LLM_BASE_URL` / `LLM_MODEL` | yes | Cascade fallback endpoint and model (use a cheap model) |
| `LLM_API_KEY` | no | API key for the fallback endpoint |
| `LITELLM_PROXY_TOKEN` | yes | Shared service token for the LiteLLM and MCP lanes |
| `AUTO_CREATE_TENANT` | no | Auto-provision unknown tenants (default false); set true for the LiteLLM and MCP lanes |
| `MAX_PROMPT_LENGTH` | no | Max accepted prompt length (default 50000) |
| `PORT` / `MCP_PORT` | no | REST / MCP listen ports (8080 / 8081) |
| `DEFAULT_GATES_CONFIG_PATH` | no | Path to the default-gates YAML |

Cron-only variables (used by the internal-learning job, not the app):

| Variable | Required | Description |
| --- | --- | --- |
| `JUDGE_BASE_URL` / `JUDGE_MODEL` | yes (cron) | Judge endpoint and model (use a capable model) |
| `JUDGE_API_KEY` | no | API key for the judge endpoint |
| `INTERNAL_LEARNING_BUDGET` | no | Judge calls per run (default 50) |

**Default gates.** [`config/default-gates.yaml`](config/default-gates.yaml) is the source of truth
for system-wide gates: `complexity_tier` (4 classes) and `request_type` (7 classes). It maps model
names to gates (`models`) and defines full gate definitions (`gates`) that are reconciled
idempotently into the database at startup. A gate needs at least two classes, each with a label and
at least one utterance.

## Deployment

The `k8s/` directory is a reference for the company's own Kubernetes setup. The app's runtime
config is in `deployment.yaml` plus the ConfigMap/Secrets; learning is opt-in via CronJobs.

**Core (required to route).**

- `k8s/deployment.yaml` — the app (REST `8080`, MCP `8081`).
- `k8s/job.migrate.yaml` — one-shot migration job; the app waits for it.
- `k8s/configmap.yaml` — non-secret config and the embedded `default-gates.yaml`.
- `k8s/secrets.example.yaml` — reference secrets (`app-db-secret`, `app-secret`); create real ones
  in the cluster and do not commit this file. The example values are placeholders for the company's
  own endpoints and models.

**Learning (opt-in CronJobs).** Whether the service learns is decided by whether these jobs are
applied, not by an app flag:

- `k8s/cron.keyword-promotion.yaml` — daily; promotes keywords from accumulated feedback.
- `k8s/cron.internal-learning.yaml` — every few days; runs the LLM-as-judge pass, bounded by
  `INTERNAL_LEARNING_BUDGET`.

If neither job is applied the service still routes correctly; it just never learns. The judge job
reads `JUDGE_MODEL` / `JUDGE_BASE_URL` from the ConfigMap and `JUDGE_API_KEY` from the Secret.

**LiteLLM integration (required for the two production lanes).** The OpenAI-compatible and MCP
lanes only work when the LiteLLM side is wired up. That lives in the sibling repo
`intent-router-litellm-plugin`:

- the `ClassifierPlugin` that turns a prompt into a tier label, plus the marker deployment and
  `tiers` mapping (`deploy/litellm-config.reference.yaml`);
- the MCP Gateway entry and the `intent_router_tenant_guardrail` that stamps the tenant header from
  LiteLLM's authenticated API key hash, also in `deploy/litellm-config.reference.yaml`;
  `deploy/litellm-values.reference.yaml` only carries the Helm values (child image and plugin env
  vars).

Both lanes share one service token (`LITELLM_PROXY_TOKEN`, sent as `intent-router-token`) and
identify tenants by the LiteLLM key hash, so the plugin lane's classification learning and the MCP
lane's gates and feedback land on the same tenant. Set `AUTO_CREATE_TENANT=true` on the router so
an unseen key hash is provisioned on first use.

**Deployment lookouts.**

- **Migrations.** The app seeds default gates at startup but does not run migrations; run the
  one-shot `migrate` job (or `pnpm db:migrate:prod`) before the app.
- **The embedding endpoint must be up before the app starts.** First boot seeds the default gates
  and indexes every utterance through the embedding API (about 165 utterances across the two
  shipped gates), so it takes a few extra seconds and fails if the endpoint is unreachable.
- **Least privilege.** `config/init-db.sql` creates `app_user` (DML) and `migrate_user` (DDL) for
  real deployments; keep the superuser out of the runtime path.

## Running locally (Docker)

```sh
# 1. Local models (skip if you use hosted endpoints)
ollama pull nomic-embed-text
ollama pull qwen2.5:7b

# 2. Build, migrate, and start (postgres → migrate → app)
docker compose up -d --build
docker compose ps                 # wait until app is healthy

# 3. Health checks
curl -s localhost:8080/health ; echo
curl -s localhost:8080/ready ; echo

# 4. Stop
docker compose down               # stop, keep data
docker compose down -v            # stop and wipe the database
```

The compose file points the app at host Ollama via `host.docker.internal`, and a one-shot
`migrate` service runs migrations before the app starts. The two shipped gates are seeded on first
boot.

To actually route a request you need one of the production lanes: wire up the LiteLLM plugin (see
Deployment) for the OpenAI-compatible or MCP lanes, or use the REST surface for a smoke test.

**REST smoke test (not a production lane).** The REST surface and its API keys are preserved but
not the intended production path; they are still the quickest way to verify routing without wiring
up LiteLLM.

```sh
# 1. Tenant + API key
docker compose exec app node dist/scripts/create-tenant.js demo
# → Created tenant "demo" (id: <uuid>)
docker compose exec app node dist/scripts/manage-keys.js create --tenant <uuid> --name demo
# → sk-… (shown once)

# 2. Route
curl -s localhost:8080/api/route \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Diagnose the intermittent crash that only reproduces in production","gate":"complexity_tier"}'
```

Ports: REST `8080`, MCP `8081`, Postgres `5432`. Inside a container, `localhost` is the container
itself; the compose file reaches host Ollama through `host.docker.internal` (`extra_hosts:
host-gateway`).

## Testing

- `pnpm test:unit` — classifiers, router, schemas, services (no DB).
- `pnpm test:integration` — database-backed tests using Testcontainers.
- `pnpm test:e2e` — REST and OpenAI-compatible surfaces.

`pnpm check` runs `tsc --noEmit`, ESLint, and Prettier together.

## Documentation index

- [`docs/architecture.md`](docs/architecture.md) — routing pipeline, online learning, and deployment.
- [`docs/API.md`](docs/API.md) — REST, MCP, and OpenAI-compatible surface contracts.