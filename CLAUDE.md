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

## Transcription runs on a background queue

Transcriptions are **not** created during the request the user is watching.
Everything goes through `src/lib/transcription/queue.ts`:

- `enqueueTranscription` / `enqueueTranscriptions` add work and return
  immediately. `POST /api/plaud/sync`, `GET /api/cron/sync` and
  `POST /api/recordings/[id]/transcribe` all use them.
- One worker runs one job at a time. ffmpeg + Whisper on a 1GB e2-micro
  OOM-cascades if two run concurrently, so **never** call `transcribeRecording`
  straight from a request handler; it has no concurrency guard of its own.
- The queue **dedupes on `recordingId`**. This matters because
  `syncRecordingsForUser` returns *all* untranscribed recordings for a user with
  `auto_transcribe` on, every single sync (browser every 5 minutes, plus cron).
  Without dedupe each sync stacked another copy of the same backlog, the queue
  grew faster than it drained, and a user-triggered job ended up behind hours of
  duplicates. A forced re-transcribe is merged into a pending job rather than
  dropped, so it can't be swallowed by an earlier auto run.
- User-triggered runs are queued with `priority: true` and jump the background
  backlog. Without that a click still landed behind dozens of auto-transcribe
  jobs, which is the same "it hangs" from the user's side.
- Queue state is **in-memory on purpose**. A restart wipes it and the status
  endpoint then honestly reports `idle`; a database column would be stuck on
  "running" forever after a crash.
- A job that outruns `JOB_TIMEOUT_MS` (45 min) is abandoned so it can't wedge the
  worker. ffmpeg/ffprobe get their own 10-minute `execFile` timeout and the
  OpenAI client a 10-minute per-chunk timeout.

**How the UI stays in sync (keep this):**
- `POST .../transcribe` answers **202** with `{ status, position, queueLength }`;
  it never waits for the transcription. An 80-minute recording takes tens of
  minutes here, and holding the request open left the panel spinning forever with
  no way to tell a slow job from a dead one.
- `GET .../transcribe` reports `{ status: idle|queued|running, position, error,
  transcription }`. `Workstation` polls it every 5s while a job is live, and asks
  once whenever the selected recording changes — that's what lets a reload adopt
  a job that's already running.
- If a transcription already exists and `force` isn't set, `POST` returns **200**
  with the existing text instead of queueing, so a client whose server-rendered
  snapshot went stale recovers on click.
- `useAutoSync` schedules a delayed `router.refresh()` when a sync reports
  `queuedTranscriptions > 0`, for the rest of the list (the selected recording
  has its own polling).

If you change sync/transcription, preserve the invariant: **the client must
reconcile with server-side transcriptions it did not trigger**, and nothing may
await a transcription inside a request handler.

## Recording filenames are titles, not paths

`recordings.filename` is overwritten with the AI-generated title after a
successful transcription, so on any later run it usually has **no extension** and
may contain spaces, accents or slashes. `compress-audio.ts` routes every name
through `toMp3Name()` for this reason: Whisper rejects an extension-less upload
with "Invalid file format", and a name containing `/` used to push ffmpeg's temp
file outside its `mkdtemp` directory.

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
