# Intent Router

A standalone, framework-agnostic **intent-routing microservice** that classifies each incoming
request against a user-configurable routing taxonomy, then refines its accuracy from user feedback.

Rather than injecting classification instructions into an agent's prompt — which couples intent
classification with task execution, consumes the finite context window, and produces
non-deterministic, hard-to-audit decisions — the intent router extracts classification into a
dedicated service that:

- routes requests through a **cascading pipeline** (keyword matching → embedding-based semantic
  search → LLM fallback), escalating to the next stage only when the cheaper stages are not
  confident enough;
- **learns online** from positive and negative feedback, so the cheap classifiers improve without
  manual reconfiguration;
- exposes the same routing logic over **REST**, **MCP**, and an **OpenAI-compatible** surface.

The project was delivered through the UCL Industry Exchange Network (IXN) scheme in collaboration
with Cisco Outshift.

---

## Features

- **Configurable routing taxonomy.** Each *gate* defines its own set of intents (*classes*), each
  annotated with keywords and utterances that seed the keyword and semantic classifiers.
- **Cascading routing.** A deterministic keyword stage and a semantic stage resolve most requests
  cheaply; only low-confidence or conflicting verdicts escalate to the LLM. A margin-and-entropy
  gate plus a disagreement check decide when to escalate.
- **Online learning.** Positive feedback adds learned embeddings and promotes keywords (TF-IDF);
  negative feedback installs veto *guardrails* that suppress a wrongly-predicted intent.
- **Multi-tenancy.** Gates, API keys, learned state, and the routing audit trail are all scoped
  per tenant. System-wide default gates are shared across tenants.
- **Three entry points.** REST and MCP surfaces authenticate with per-tenant API keys; an
  OpenAI-compatible surface sits behind a LiteLLM proxy and authenticates with a shared service
  token.
- **Auditable.** Every routing decision is persisted as a `routing_events` row with its deciding
  stage, score distribution, and channel, forming the substrate for feedback and analytics.
- **Containerised.** A single multi-stage Docker image serves the application, the one-shot
  migration, and the scheduled keyword-promotion job, with reference Kubernetes manifests.

---

## Architecture

The service is a single Node.js/TypeScript process that delegates all persistence to PostgreSQL
(with the `pgvector` extension) and reaches hosted language and embedding models through one
LiteLLM proxy.

![System design](docs/assets/system-design.png)

Three entry points converge on a single service layer and routing cascade:

- **REST** — Fastify routes for routing (`/api/route`, `/api/feedback`) and gate CRUD
  (`/api/gates`), authenticated with a per-tenant API key.
- **MCP** — a FastMCP server embedded in the same process (separate port), re-exposing the same
  operations as tools.
- **LiteLLM / OpenAI-compatible** — `/v1/models` and `/v1/chat/completions`, so existing OpenAI
  clients route through the LiteLLM proxy without modification.

The routing core is the cascading router:

![Cascading router](docs/assets/full-router.png)

1. The **keyword** and **semantic** classifiers run in parallel (only those with configured
   signal), and their normalized distributions are blended linearly (`kw × 0.3 + sem × 0.7`).
2. A **confidence gate** (relative top-1/top-2 margin, normalized entropy) and an **agreement
   gate** (confident-but-conflicting verdicts) decide whether the blend is trustworthy.
3. If not, the **LLM classifier** picks a bare label (with retries), degrading gracefully to the
   pre-cascade result and finally to the most-frequent historical class.

A detailed write-up lives in [`docs/architecture.md`](docs/architecture.md), and the full
request/response contracts are in [`docs/API.md`](docs/API.md).

---

## Repository layout

```
config/            static configuration (default gates, DB bootstrap)
drizzle/           SQL migrations and their metadata
scripts/           operational CLI (tenant/key management, migration, learning)
docs/              architecture and API documentation
k8s/               reference Kubernetes manifests
src/
  auth/            API-key verification and the Fastify auth plugin
  gates/           gate and class CRUD, default-gate seeding
  health/          liveness (/health) and readiness (/ready) endpoints
  clients/         shared upstream clients (embedding, LLM)
  mcp/             Model Context Protocol server and tools
  openai/          OpenAI-compatible chat-completions proxy
  routing/         the routing pipeline
    classifiers/   keyword, semantic, and LLM classifiers
    router/        the cascading router
  store/           persistence (Drizzle schema and per-table modules)
```

HTTP-facing packages follow a consistent three-file split: `routes.ts` declares the endpoints,
`schema.ts` holds request validation, and `service.ts` implements the business logic; `store/`
isolates all database access behind the Drizzle schema.

---

## Configuration

Environment variables are validated at startup (see `.env.example`):

| Variable                   | Required | Description                                      |
| -------------------------- | -------- | ------------------------------------------------ |
| `DATABASE_URL`             | yes      | PostgreSQL connection string (needs `pgvector`)  |
| `EMBED_BASE_URL`           | yes      | Base URL of the embedding endpoint (LiteLLM)     |
| `EMBED_MODEL`              | yes      | Embedding model name                             |
| `EMBED_DIMS`               | no       | Embedding dimensions (auto-detected if omitted)  |
| `LLM_BASE_URL`             | yes      | Base URL of the chat-completions endpoint        |
| `LLM_MODEL`                | yes      | LLM model name                                   |
| `LLM_API_KEY`              | no       | API key for the LLM endpoint                     |
| `MAX_PROMPT_LENGTH`        | no       | Max prompt length accepted for routing (50000)   |
| `LITELLM_PROXY_TOKEN`      | yes      | Shared service token for the OpenAI-compatible surface |
| `PORT` / `MCP_PORT`        | no       | REST / MCP listen ports (8080 / 8081)            |
| `DEFAULT_GATES_CONFIG_PATH`| no       | Path to the default-gates YAML (see below)       |

**Default gates.** [`config/default-gates.yaml`](config/default-gates.yaml) is the source of truth
for system-wide gates. It maps model names to gates (`models`) and defines full gate definitions
(`gates`) that are reconciled idempotently into the database at startup. A gate needs at least two
classes, each with a label and at least one utterance.

---

## API documentation

The full request/response contracts, authentication, and error conventions for all three entry
points are documented in [`docs/API.md`](docs/API.md).

---

## Testing

The test suite is split into three Vitest projects (`vitest.config.ts`):

- `pnpm test:unit` — unit tests for the classifiers, router, schemas, and services.
- `pnpm test:integration` — database-backed tests using Testcontainers.
- `pnpm test:e2e` — end-to-end tests exercising the REST and OpenAI-compatible surfaces.

`pnpm check` runs the type-checker (`tsc --noEmit`), ESLint, and Prettier together.

---

## Running the program

This section takes you from a fresh checkout to a working `POST /api/route`
round-trip. Two paths are supported:

- **Option A — host development** (recommended quickstart): the app runs on your
  machine with Node/pnpm, and only Postgres runs in Docker. Fastest iteration
  loop.
- **Option B — full Docker**: `docker compose up` builds and runs everything
  (Postgres, a one-shot migration, and the app) in containers. No Node needed.

Both options default to **Ollama** for the embedding and LLM stages — a zero-key
local model server. Any OpenAI-compatible endpoint can be used instead by
changing `EMBED_BASE_URL` / `LLM_BASE_URL` (plus the optional API keys).

The shipped [`config/default-gates.yaml`](config/default-gates.yaml) defines two
gates out of the box — `complexity_tier` (4 classes) and `request_type`
(7 classes) — so routing works immediately after seeding.

### Prerequisites

- **Docker** — Docker Desktop (macOS/Windows) or Docker Engine + the `docker
  compose` plugin (Linux). Colima works on macOS too. Option A needs it only for
  Postgres; Option B needs it for everything.
- **Node ≥ 22 and pnpm** — Option A only. Enable pnpm with
  `corepack enable pnpm` (bundled with Node) or `npm install -g pnpm`. Option B
  needs neither.
- **Ollama** (recommended, not required) — install it and pull the two models
  used below. Or skip it and point the app at an OpenAI-compatible endpoint.

### Option A — run the app on your host

```sh
# 1. Postgres (with pgvector), in Docker
docker compose up -d postgres
docker compose ps                 # wait until postgres is healthy

# 2. Ollama models (skip if you use a hosted endpoint)
ollama pull nomic-embed-text      # embedding model
ollama pull qwen2.5:7b            # LLM used by the cascade's last stage

# 3. Configuration — the example is pre-filled for the local setup
cp .env.example .env

# 4. Dependencies
pnpm install

# 5. Migrations (one-off; the app does NOT run them for you)
DATABASE_URL="postgres://postgres:postgres@localhost:5432/intent-router" \
  pnpm db:migrate:prod

# 6. Tenant + API key
DATABASE_URL="postgres://postgres:postgres@localhost:5432/intent-router" \
  pnpm create:tenant -- demo
# → Created tenant "demo" (id: <uuid>)
DATABASE_URL="postgres://postgres:postgres@localhost:5432/intent-router" \
  pnpm exec tsx scripts/manage-keys.ts create --tenant <uuid> --name demo
# → sk-… (shown once — save it)

# 7. Start
pnpm dev                          # or: pnpm build && node dist/src/index.js

# 8. Smoke test
curl -s localhost:8080/health ; echo
curl -s localhost:8080/ready ; echo
curl -s localhost:8080/api/route \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Diagnose the intermittent crash that only reproduces in production","gate":"complexity_tier"}'
```

### Option B — run everything in Docker

```sh
# 1. Ollama models on the host (skip if you use a hosted endpoint)
ollama pull nomic-embed-text
ollama pull qwen2.5:7b

# 2. Build, migrate, and start (postgres → migrate → app)
docker compose up -d --build
docker compose ps                 # wait until app is healthy

# 3. Tenant + API key, inside the running container
docker compose exec app node dist/scripts/create-tenant.js demo
# → Created tenant "demo" (id: <uuid>)
docker compose exec app node dist/scripts/manage-keys.js create \
  --tenant <uuid> --name demo
# → sk-… (shown once — save it)

# 4. Smoke test — same curl commands as Option A (ports 8080 / 8081)

# 5. Stop
docker compose down               # stop, keep data
docker compose down -v            # stop and wipe the database
```

### Seed a tenant and an API key

Tenants and API keys are **not** created automatically. A tenant is the
ownership scope for gates, keys, and routing history; an API key authenticates
REST/MCP requests on behalf of that tenant.

Option A (host):

```sh
DATABASE_URL="postgres://postgres:postgres@localhost:5432/intent-router" \
  pnpm create:tenant -- demo
# → Created tenant "demo" (id: <uuid>)

DATABASE_URL="postgres://postgres:postgres@localhost:5432/intent-router" \
  pnpm exec tsx scripts/manage-keys.ts create --tenant <uuid> --name demo
# → sk-… (shown once — save it)
```

Option B (Docker):

```sh
docker compose exec app node dist/scripts/create-tenant.js demo
# → Created tenant "demo" (id: <uuid>)

docker compose exec app node dist/scripts/manage-keys.js create \
  --tenant <uuid> --name demo
# → sk-… (shown once — save it)
```

The key is shown **once** — only its SHA-256 hash is stored, so the plaintext
cannot be recovered. Other key operations (`list`, `disable`, `enable`,
`rename`, `extend`, `transfer`) live in `scripts/manage-keys.ts`.

### Call the routing endpoint

Route a request with `POST /api/route` and the `Authorization: Bearer <key>`
header. The body takes a `prompt` and the name of the `gate` to classify
against:

```sh
curl -s localhost:8080/api/route \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Diagnose the intermittent crash that only reproduces in production","gate":"complexity_tier"}'
```

The response is `{ routeId, label, score, stage, scores }` — `stage` is the
cascade stage that made the decision (`pre-cascade`, `keyword`, `semantic`, or
`llm`), and `scores` is the per-class distribution.

The shipped config defines two gates, so both work out of the box:

```sh
# complexity_tier → "reasoning"
curl -s localhost:8080/api/route -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Diagnose the intermittent crash that only reproduces in production","gate":"complexity_tier"}'

# request_type → "code_generation"
curl -s localhost:8080/api/route -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"add a new endpoint that streams paginated results to the client","gate":"request_type"}'
```

Liveness and readiness are `GET /health` and `GET /ready`. To define your own
gates and classes, use the gate CRUD endpoints (`POST /api/gates`, etc.) — see
[`docs/API.md`](docs/API.md).

### Things to watch out for

- **Migrations are not automatic in Option A.** The app only seeds the default
  gates at startup, which requires the tables to already exist — run step 5
  before the first start. Option B runs migrations for you via a one-shot
  `migrate` service that the app waits for.
- **The embedding endpoint must be up before the app starts.** On a fresh
  database, startup seeds the default gates and indexes every utterance through
  the embedding API. With the shipped two-gate config that is ~165 utterances,
  so the first boot takes a few extra seconds and fails if the endpoint is
  unreachable.
- **The app reads `.env`; the CLI scripts do not.** `pnpm dev` loads `.env`
  automatically, but the migration/tenant/key scripts read `DATABASE_URL` from
  the shell — prefix them as shown above.
- **The API key is printed once.** Only its SHA-256 hash is stored, so it cannot
  be recovered later.
- **Ports.** REST `8080`, MCP `8081`, Postgres `5432`. Free them first, or
  override: `${APP_PORT}` / `${MCP_PORT}` / `${POSTGRES_PORT}` in compose,
  `PORT` / `MCP_PORT` in `.env`.
- **`docker compose` vs `docker-compose`.** Docker Desktop ships the `docker
  compose` plugin; if that is unavailable, the standalone `docker-compose`
  accepts the same commands.
- **`host.docker.internal`.** Inside a container, `localhost` is the container
  itself, so Option B reaches host Ollama through `host.docker.internal`. The
  compose file includes `extra_hosts: host-gateway` so this also works on Linux.
- **Keeping the Docker build reproducible.** The image runs
  `pnpm install --frozen-lockfile` against `pnpm-lock.yaml`, so if you change
  dependencies commit the updated lockfile to keep it in sync.

### Database roles (least privilege)

For local development, both options use the Postgres **superuser** URL
(`postgres://postgres:postgres@localhost:5432/intent-router`) — one URL, no
permission surprises. The bootstrap script
([`config/init-db.sql`](config/init-db.sql)) additionally creates two
least-privilege roles for real deployments:

- **`app_user`** — DML only (`SELECT`/`INSERT`/`UPDATE`/`DELETE`); connect the
  running app with this role.
- **`migrate_user`** — DDL allowed; run `db:migrate:prod` with this role.

In production you would run migrations as `migrate_user` and the app as
`app_user`, keeping the superuser out of the runtime path.

---

## Documentation index

- [`docs/architecture.md`](docs/architecture.md) — system design, routing pipeline, online learning, and deployment.
- [`docs/API.md`](docs/API.md) — REST, MCP, and OpenAI-compatible surface contracts.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.
