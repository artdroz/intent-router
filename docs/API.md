# API Reference

This document specifies the request/response contracts of the three entry points exposed by the
intent router. Every request body is validated against a [Zod](https://zod.dev) schema, so the
constraints listed below are enforced, not advisory.

- **REST** — routing and gate-management under `/api`, authenticated with a per-tenant API key.
- **MCP** — the same operations re-exposed as Model Context Protocol tools, authenticated with the
  shared service token plus a tenant header.
- **LiteLLM / OpenAI-compatible** — `/v1/models` and `/v1/chat/completions`, authenticated with a
  shared service token plus a tenant header.

## Conventions

- Base URL: `http://<host>:8080` for REST and the OpenAI-compatible surface; `http://<host>:8081`
  for the MCP server (streamable HTTP, mounted at `/mcp`).
- All request and response bodies are JSON (`Content-Type: application/json`).
- A body that fails schema validation is rejected with `400`.
- Every request resolves to a **tenant id** before any routing work happens (see
  [Authentication](#authentication)); all configuration, learned state, and audit records are
  scoped by that tenant.

## Authentication

| Surface                     | Mechanism                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| REST                        | `Authorization: Bearer <api-key>`. Missing, unknown, disabled, or expired keys are rejected with a distinct `401`.                  |
| MCP                         | `intent-router-token` header matching the configured proxy token **and** an `intent-router-tenant` header naming the tenant, checked in the MCP server's `authenticate` callback. With `AUTO_CREATE_TENANT` enabled, an unknown tenant is created on first sight instead of being rejected. |
| LiteLLM / OpenAI-compatible | `intent-router-token` header matching the configured proxy token **and** an `intent-router-tenant` header naming the tenant. With `AUTO_CREATE_TENANT` enabled, an unknown tenant name is created on first sight instead of being rejected. |

API keys are generated as `sk-<uuid>`, stored as a SHA-256 hash, and managed through the operator
scripts (`scripts/manage-keys.ts`).

## Error model

Every entry point returns a structured error. The REST surface uses:

```json
{ "error": "<message>", "details": [] }
```

where `details` is present only for validation failures. The OpenAI-compatible surface uses the
OpenAI error envelope:

```json
{ "error": { "message": "<message>", "type": "<type>", "code": <status> } }
```

| Status | Meaning                                   | OpenAI `type`          |
| ------ | ----------------------------------------- | ---------------------- |
| 400    | Request failed validation or a business rule | `invalid_request_error` |
| 401    | Missing/invalid/disabled/expired credentials | `authentication_error` |
| 404    | Referenced resource not found             | `invalid_request_error` |
| 409    | Conflict with existing state (e.g. duplicate label) | `invalid_request_error` |
| 502    | Upstream embedding/LLM call failed        | `server_error`         |
| 500    | Unhandled internal error                  | `server_error`         |

---

## REST API

### Routing

#### `POST /api/route`

Route a prompt to an intent label within a gate. Returns `200` with the routing decision.

**Request body** (`routeRequestSchema`):

| Field  | Type   | Constraints | Description                |
| ------ | ------ | ----------- | -------------------------- |
| `prompt` | string | 1+ chars  | The text to classify.      |
| `gate`   | string | 1–100 chars | The gate to route against. |

```json
{ "prompt": "Investigate the flaky CI test", "gate": "complexity-tier" }
```

**Response** `200`:

```json
{
  "routeId": "r_01abc...",
  "label": "complex",
  "score": 0.87,
  "stage": "pre-cascade",
  "scores": { "simple": 0.13, "complex": 0.87 }
}
```

| Field    | Description                                                    |
| -------- | -------------------------------------------------------------- |
| `routeId`| Public id of the routing event; use it to submit feedback.     |
| `label`  | Predicted intent label.                                        |
| `score`  | Probability of the predicted label (0–1).                      |
| `stage`  | Deciding stage: `pre-cascade`, `llm`, or `historical`.         |
| `scores` | Per-class score distribution of the deciding stage.            |

**Errors:** `400` (validation, prompt too long, gate unknown), `404` (gate not found).

#### `POST /api/feedback`

Submit feedback for a previous routing decision. Returns `204` with no body.

**Request body** (`feedbackSchema`):

| Field     | Type    | Constraints | Description                              |
| --------- | ------- | ----------- | ---------------------------------------- |
| `routeId` | string  | 1+ chars    | The `routeId` returned by `POST /api/route`. |
| `positive`| boolean | —           | `true` confirms, `false` corrects the decision. |

**Errors:** `400` (validation), `404` (route not found or owned by another tenant).

### Gates

Gate-management endpoints operate on a gate and its classes. The response shape of a gate:

```json
{
  "id": 1,
  "tenantId": "…",
  "name": "complexity-tier",
  "description": "Routes tasks by complexity tier.",
  "config": { "learningEnabled": true },
  "classes": [
    {
      "id": 1,
      "label": "simple",
      "description": "Simple, single-step tasks.",
      "utterances": ["What is the capital of France?"],
      "keywords": ["simple", "easy"]
    }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

| Endpoint                                   | Method | Purpose                       | Success |
| ------------------------------------------ | ------ | ----------------------------- | ------- |
| `/api/gates`                               | POST   | Create a gate.                | 201     |
| `/api/gates`                               | GET    | List the tenant's gates (own + shared system gates). | 200 |
| `/api/gates/:name`                         | GET    | Fetch one gate by name.       | 200     |
| `/api/gates/:name`                         | PATCH  | Update a gate's name, description, or config. | 200 |
| `/api/gates/:name`                         | DELETE | Soft-disable a gate.          | 204     |
| `/api/gates/:name/classes`                 | POST   | Add a class to a gate.        | 201     |
| `/api/gates/:name/classes/:label`          | PATCH  | Update a class.               | 200     |
| `/api/gates/:name/classes/:label`          | DELETE | Delete a class.               | 204     |

**Invariants** (enforced by `gates/schema.ts` and `gates/service.ts`):

- A gate holds between 2 and 50 classes.
- Class labels are unique within a gate; a gate name is never reusable (even after disabling).
- Every class carries at least one utterance.

**Request schemas:**

`createGateSchema` — `name` (2–100 chars), optional `description` (≤500), `config` =
`{ learningEnabled: boolean }`, `classes` (2–50 of `addClassSchema`).

`addClassSchema` / `updateClassSchema` — `label` (1–50 chars), optional `description` (≤500),
optional `utterances` (`string[]`, each 1–500 chars), optional `keywords` (`string[]`, each 1–100
chars).

`updateGateSchema` — optional `name`, `description`, `config`.

**Errors:** `400` (validation), `404` (gate/class not found), `409` (duplicate label, name reuse).

---

## MCP tools

The MCP server exposes the same operations as tools; each tool's arguments are validated by the
same Zod schemas, so a tool's contract is identical to its REST counterpart.

| Tool             | Arguments                                  | Returns                          |
| ---------------- | ------------------------------------------ | -------------------------------- |
| `route_intent`   | `routeRequestSchema`                       | routing decision (`routeId`, `label`, `score`, `stage`, `scores`) |
| `submit_feedback`| `feedbackSchema`                           | `{ ok: true }`                   |
| `list_gates`     | —                                          | `Gate[]`                         |
| `get_gate`       | `{ name }`                                 | `Gate`                           |
| `create_gate`    | `createGateSchema`                         | created `Gate`                   |
| `update_gate`    | `{ gate, patch }` (`patch` = `updateGateSchema`) | updated `Gate`             |
| `disable_gate`   | `{ name }`                                 | `{ ok: true }`                   |
| `add_class`      | `{ gate, class }` (`class` = `addClassSchema`) | created `GateClass`         |
| `update_class`   | `{ gate, label, patch }` (`patch` = `updateClassSchema`) | updated `GateClass` |
| `delete_class`   | `{ gate, label }`                          | `{ ok: true }`                   |

Tool errors are returned as MCP tool results with the same messages as the REST surface.

---

## OpenAI-compatible surface

This surface speaks the OpenAI chat-completions protocol so that existing OpenAI clients can reach
the router through a LiteLLM proxy without modification.

#### `GET /v1/models`

Returns the models advertised by the service (derived from the `models` map in the default-gates
config).

```json
{ "object": "list", "data": [ { "id": "complexity-tier", "object": "model", "created": 1720000000, "owned_by": "intent-router" } ] }
```

#### `POST /v1/chat/completions`

Accepts a chat-completions body, extracts the last user message as the routing prompt, maps the
requested model to a gate (via the config's `models` map, falling back to the model name itself as
the gate), and returns a chat completion whose `content` carries the routing decision.

**Request body** (`chatCompletionRequestSchema`):

| Field      | Type      | Constraints             | Description                         |
| ---------- | --------- | ----------------------- | ----------------------------------- |
| `model`    | string    | 1+ chars                | Model name; mapped to a gate.       |
| `messages` | array     | 1+ items                | Chat messages; the last user message is the routing prompt. |
| `stream`   | boolean   | optional                | Not supported yet (rejected with `400`). |

```json
{
  "model": "complexity-tier",
  "messages": [
    { "role": "user", "content": "Investigate the flaky CI test" }
  ]
}
```

**Response** `200` (chat completion):

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1720000000,
  "model": "complexity-tier",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"routeId\":\"r_…\",\"label\":\"complex\",\"score\":0.87,\"stage\":\"pre-cascade\",\"scores\":{\"simple\":0.13,\"complex\":0.87}}"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

The routing decision is JSON-serialized into `choices[0].message.content`.

**Errors:** `400` (validation, streaming unsupported, no user message), `401` (bad token/tenant),
`404` (gate not found), `500` (unhandled error).

#### `GET /v1/intent-router/gates/:name/classes`

Service-level introspection for the LiteLLM classifier plugin: returns the labels of a gate's
classes so the plugin can verify its `tier_definitions` match. Token-only (no tenant header).

```json
{ "classes": ["simple", "medium", "complex"] }
```

**Errors:** `401` (bad token), `404` (gate not found).
