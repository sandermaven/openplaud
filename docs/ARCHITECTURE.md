# Architecture Overview

This document describes the high-level architecture and design decisions
behind OpenPlaud, intended as a reference for anyone bootstrapping a
similar project (a Next.js app on a free-tier VM that pulls data from an
external API and pushes processed output to a destination service).

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) on Bun runtime |
| Database | PostgreSQL 17 in Docker |
| ORM | Drizzle (idempotent migration runner) |
| Auth | better-auth |
| Reverse proxy | Caddy (auto-HTTPS via Let's Encrypt) |
| Lint/format | Biome |
| Tests | Vitest |

## Infrastructure

| Component | Choice | Why |
| --- | --- | --- |
| Hosting | GCE `e2-micro` (1GB RAM, 30GB disk, us-central1) | Free tier, ~$0/mo |
| DNS | Cloudflare A-record to VM IP (proxy optional) | Cheap, easy SSL |
| Containers | Docker Compose (`db` + `app`) | Single `docker compose up -d` for full stack |
| Build | On the VM, but temporarily upscale to `e2-medium` for the build | 1GB RAM cannot build Next.js reliably; cents per build |
| Cron | Linux crontab on the VM, calling app endpoints via curl | No separate scheduler; same process |
| Monitoring | Scheduled remote agent (1×/day health check, emails on failure) | Free, no Datadog needed |

## Architecture pattern

A pull-based sync feeding a serial transcribe / process pipeline:

```
[External source]
      │
      ▼  every 15 min
   cron-sync ──▶ [DB queue]
                     │
                     ▼  serial, locked
              process pipeline ──▶ [Notion / output]

   cron-cleanup (daily, audio files only)
```

Key principles:

- **One cron endpoint for sync, one for cleanup.** Never duplicate the
  cleanup logic inside the sync route — that turns a daily safe operation
  into a 15-minute destructive one. (We learned this the painful way.)
- **Failure tracking on the queue table.** Every recording row carries
  `last_attempt_at`, `failure_count`, `error_message`. The pending-pool
  query filters on cooldown + max-retries.
- **Serialize async work** with a module-level Promise chain inside the
  pipeline function. Prevents parallel CPU/IO-heavy jobs from drowning a
  small VM.
- **Cleanup may delete artifacts (audio files), never source-of-truth
  rows** if the upstream system still retains them. Otherwise the next
  sync re-pulls the same id and the pipeline runs again — duplicate
  output, duplicate spend.

## Lessons to bake in from day one

1. **Idempotent dedup key from the external API** — store its id in a
   `UNIQUE NOT NULL` column. Use that as the dedup key, not your internal
   row id.
2. **No cascade-delete** between an "owner" row and "produced data"
   stored externally. Cascade kills the local memory of what was
   produced; the next sync replays the work.
3. **Lock I/O-heavy async paths** when running on a constrained VM. A
   ~10-line in-process Promise chain is enough.
4. **Failure tracking with cooldown + cap** in your queue table prevents
   retry storms when an external API throttles, errors, or runs out of
   credit.
5. **Normalize external API responses** at the boundary (e.g. coerce a
   detected language `english` → ISO `en` immediately on receipt).
6. **One daily uptime check** sending a notification on failure, set up
   on day one. Otherwise you find out a week later that the VM is hung.
7. **Keep `docker-compose.yml` env-driven.** No hardcoded passwords or
   URLs; everything from `.env`. Avoids local-only diffs on production.
8. **Build on `e2-medium` temporarily**, then resize back to
   `e2-micro`. Don't fight a 1GB RAM Next.js build with swap thrashing.

## Setup order (high-level)

1. **Repo**: Next.js + Bun + Drizzle + Docker Compose + Biome + Vitest.
2. **Schema**: queue table with `external_id UNIQUE NOT NULL` plus
   `failure_count`, `last_attempt_at`, `error_message`.
3. **Pipeline**: serialize with module-level lock, mark failures,
   respect cooldown and failure cap.
4. **Cron endpoints**: sync (frequent), cleanup (daily). No overlap in
   responsibilities.
5. **Caddyfile**: 4 lines —
   `domain { reverse_proxy localhost:3000 }`.
6. **GCE VM**: e2-micro Ubuntu 24.04, install Docker + Caddy.
7. **DNS**: A-record to the VM. Cloudflare proxy optional.
8. **Monitoring**: scheduled remote agent for daily uptime check.

## Risks to address upfront

- **External API quota / rate limit** → failure cap stops retry storms.
- **OOM on 1GB RAM** → 2GB swap + serialization lock + monitoring.
- **Cleanup × re-sync interaction** → cleanup must never touch dedup
  keys or rows that the upstream still holds.
- **Docker layer cache lost on small builders** → temp upscale for
  builds, never permanent.
