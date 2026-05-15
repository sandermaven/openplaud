# Re-transcribe with language override

## Problem

When Whisper auto-detects the wrong language, the transcription hallucinates badly (e.g. a Dutch recording detected as Turkish produces gibberish like "van van van…"). Today the user has no way to:

1. Force a specific language for transcription.
2. Re-run transcription on a recording that already has a (bad) result.

The route at `src/app/api/recordings/[id]/transcribe/route.ts` ignores the user's `defaultTranscriptionLanguage` setting entirely, while the background path at `src/lib/transcription/transcribe-recording.ts:124` does honor it. The two paths have drifted.

## Goal

Let the user pick a language per-recording (Auto / Nederlands / English) and re-run transcription with one click. Failure-counter resets on manual retry.

## Non-goals

- Per-user language picker UI in settings (the field exists in the DB; a global default UI is out of scope).
- Multi-language transcription within a single recording.
- Preserving previous transcription as history — overwrite in place.
- Adding more than the three language options (Auto / NL / EN). Other languages stay supported via the existing `defaultTranscriptionLanguage` setting if a user sets it directly in DB, but no UI yet.

## Design

### UI — `transcription-panel.tsx`

The panel header always shows a small language selector next to the action button, regardless of transcription state:

```
┌─ Transcription ──────────────────────────────────────────┐
│  📄 Transcription          [Auto ▼]  [✨ Transcribe]      │
│                            ─────────                      │
│                            Auto                           │
│                            Nederlands                     │
│                            English                        │
└──────────────────────────────────────────────────────────┘
```

- Default selection: **Auto**.
- When a transcription already exists, the right-hand button changes from "Transcribe" → "Re-transcribe" (with a refresh icon).
- Clicking "Re-transcribe" opens a confirm dialog: *"This will overwrite the current transcription and incur API cost (~$X). Continue?"* The cost shown is the same `costEstimate` already computed for the existing transcription (good enough — same model, same duration).
- During transcribing, dropdown and button are disabled and the existing "Transcribing audio…" spinner state is shown.

### Backend — POST `/api/recordings/[id]/transcribe`

Accept optional JSON body:

```ts
{
  language?: "nl" | "en" | null,  // null/undefined = auto-detect
  force?: boolean                  // required to overwrite existing transcription
}
```

Behavior:

- If `language` is provided, pass it through to Whisper as the `language` param.
- If a transcription already exists with text and `force !== true`, return 409 with a clear error (so the UI can prompt for confirmation before retrying — though in practice the UI sends `force: true` directly from the confirm dialog).
- On success, reset `recordings.transcriptionFailureCount = 0` and `transcriptionError = null` (already done today).
- Read `userSettings.defaultTranscriptionLanguage` as fallback when `language` is not passed (parity with the background path).

### Refactor — share language logic between the two paths

The API route currently does its own (simpler) Whisper call and ignores user settings. Instead, the route should delegate to a shared function so both paths behave identically.

**Approach**: extend `runTranscription()` in `src/lib/transcription/transcribe-recording.ts` to accept optional `{ languageOverride?: string | null, force?: boolean }` params. The route becomes a thin wrapper that:

1. Auths the user
2. Parses request body
3. Calls `transcribeRecording(recordingId, userId, { languageOverride, force })`
4. Returns the result

Resolution order for the language Whisper receives:
1. `languageOverride` (per-request from UI)
2. `userSettings.defaultTranscriptionLanguage`
3. `null` (Whisper auto-detect)

This kills the divergence and means manual transcribes also benefit from chunking, default-language fallback, and the Notion auto-sync that the lib function already does.

### Data model

No schema changes. `transcriptions.detectedLanguage` continues to store whatever Whisper reports — when `language` is forced, Whisper echoes it back, so the field remains accurate.

### Error handling

- 401 if not authed (existing).
- 404 if recording not owned by user (existing).
- 400 if no transcription API configured (existing).
- 409 if transcription exists and `force !== true`.
- 500 with `transcriptionError` written to `recordings` row (existing).

### Testing

- Unit: `runTranscription` honors `languageOverride` over `defaultTranscriptionLanguage` over auto-detect.
- Unit: `runTranscription` with `force: true` overwrites existing transcription; without it, returns early as today.
- Manual: take a recording that auto-detected wrong, set language to NL, confirm overwrite → text is now coherent Dutch, language field shows `nl`, cost estimate updated.

## Open questions

None — design approved in chat (2026-05-15).
