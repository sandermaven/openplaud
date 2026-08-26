# OpenPlaud — notes for coding sessions

Context and gotchas that aren't obvious from the code. Read this before touching
sync, transcription, or the multi-user data model.

## Deployment & tenancy (important)

- **One deployment, one database, multiple users.** The Maven instance runs on a
  single Google Cloud Compute Engine VM (`openplaud`, zone `us-central1-a`) with
  Docker Compose: an `openplaud-app` container and an `openplaud-db` Postgres
  container (see `docker-compose.yml`). There is **no** per-user database and no
  Cloud SQL instance.
- **Tenants are separated logically by `user_id`, not physically.** Every domain
  table (`recordings`, `transcriptions`, `user_settings`, `plaud_connections`, …)
  carries a `user_id` and is filtered on it. Two logins sharing this deployment is
  by design; you do **not** need a second deployment to isolate two users.
- Each user has their own `plaud_connections` row (own bearer token to their own
  Plaud cloud account). Two users should point at **separate Plaud accounts** so
  their `plaud_file_id`s never collide (see next point).

### The two-account footgun: `plaud_file_id` is globally unique

`recordings.plaud_file_id` has a **global** unique constraint (`schema.ts`), and
sync looks up existing recordings by `plaud_file_id` **without** scoping by user
(`src/lib/sync/sync-recordings.ts`). Consequences if two users ever ingest the
same Plaud file id:

- Only one `recordings` row can exist for that id, and the sync **reassigns its
  `user_id` to whoever synced last** (ownership ping-pongs). The transcription
  stays with the original owner, so it becomes invisible in the UI (dashboard
  filters transcriptions by `user_id`) while still blocking re-transcribe.

This is safe **only** because the two Maven users use separate Plaud accounts
(disjoint ids). If you ever add real multi-tenant device sharing, change the
constraint to a composite unique `(user_id, plaud_file_id)` and scope the sync
lookup by `user_id`.

## Auto-transcription is out-of-band — snapshots go stale

Transcriptions are **not** created during the request the user is watching:

- `POST /api/plaud/sync` runs the sync, responds immediately, then transcribes
  pending recordings inside a Next.js `after()` block — i.e. **after** the
  response is sent (`src/app/api/plaud/sync/route.ts`).
- `POST /api/cron/sync` does the same on a schedule, with no browser involved.
- `syncRecordingsForUser` queues **all** untranscribed recordings for a user with
  `auto_transcribe` on, not just newly-synced ones — so transcriptions appear for
  recordings that were synced days ago, with `newRecordings === 0`.

The dashboard (`dashboard/page.tsx` → `Workstation`) is server-rendered once and
holds a fixed `transcriptions` map prop. Because the transcription is written out
of band and the client only re-fetched on `newRecordings > 0`, a transcription
could exist server-side while the panel still shows **"No transcription
available"**. Clicking Transcribe then hit a 409 and left the user stuck.

**Fixes in place (keep them):**
- `transcribeRecording` returns the existing transcription (not just an
  `alreadyExists` flag) when one is already present, and the transcribe route
  returns it as **200** instead of 409 — so a stale client recovers on click
  (`src/lib/transcription/transcribe-recording.ts`, `.../transcribe/route.ts`).
- `useAutoSync` schedules a delayed `router.refresh()` when a sync reports
  `pendingTranscriptions > 0`, so background results land without a manual reload
  (`src/hooks/use-auto-sync.ts`).

If you change sync/transcription, preserve the invariant: **the client must
reconcile with server-side transcriptions it did not trigger.**

## Known issue: duplicate transcription rows

`transcriptions` has **no** unique constraint on `recording_id`, and the
check-then-insert in `transcribeRecording` isn't atomic. Two near-simultaneous
runs (auto-transcribe + manual, or two sync cycles) can insert duplicates. At
least one exists in prod (`recording_id = m4yFd_LGWGwDMSTN3lhSz`, two rows).
Proper fix: add a unique constraint / upsert (`onConflictDoUpdate`) and dedupe
existing rows in the migration (deleting prod data — get sign-off first).

## Inspecting the production database

The API admin surfaces (Cloud SQL, Cloud Run) are **not** enabled on the GCP
project; Postgres runs in a container on the VM. Query it read-only via SSH:

```bash
gcloud compute ssh openplaud --zone us-central1-a --tunnel-through-iap \
  --command="sudo docker exec openplaud-db psql -U postgres -d openplaud -c \"<SQL>\""
```

## Local dev

- Runtime/package manager in Docker is **Bun** (`Dockerfile`, `pnpm-lock.yaml`).
  Locally `npm install` works for running checks if Bun isn't present.
- Verify changes with: `npm run type-check`, `npx vitest run`, `npm run
  format-and-lint`. Tests run in a **node** env (no DOM) — there's no React
  Testing Library, so client components are covered by type-check + manual QA,
  not unit tests.
- Deploy is PR-based onto `main` (see recent history: one squash-merged PR per
  fix).
