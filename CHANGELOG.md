# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-07

### Added

- Cascading routing pipeline: keyword + semantic pre-cascade with an LLM fallback.
- Keyword classifier with configured and promoted (TF-IDF) keyword weighting.
- Semantic classifier with pgvector nearest-neighbour search and negative-feedback veto guardrails.
- LLM classifier with bare-label output and retry.
- Online learning from user feedback: keyword promotion (scheduled) and embedding/guardrail learning.
- Multi-tenant data isolation across gates, API keys, learned state, and the routing audit trail.
- Three entry points: REST (Fastify), MCP (FastMCP), and an OpenAI-compatible surface.
- API-key and proxy-token authentication.
- Per-tenant API-key management scripts.
- Default-gate configuration with idempotent, advisory-lock-guarded seeding.
- PostgreSQL schema (Drizzle) with pgvector support.
- Docker image and reference Kubernetes manifests.
- Unit, integration, and end-to-end test suites (Vitest + Testcontainers).
