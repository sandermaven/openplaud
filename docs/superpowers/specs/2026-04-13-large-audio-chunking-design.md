# Large Audio Chunking for Transcription

## Problem

Recordings longer than ~70 minutes exceed Whisper's 25MB upload limit even after compression (48kbps mono MP3). The API call fails silently — the recording stays stuck in the UI with no transcription and no error feedback.

## Solution

Split large audio files into 30-minute chunks, transcribe each separately, and concatenate the results.

## Design

### `compress-audio.ts`

**Return type changes** from a single object to an array:

```typescript
Promise<{ buffer: Buffer; filename: string; contentType: string }[]>
```

**Flow:**

1. If file is small enough and has supported format, return `[original]`
2. Compress full file with ffmpeg (as today)
3. If compressed result fits under 24MB, return `[compressed]`
4. If still too large:
   - Get duration via `ffprobe`
   - Calculate chunk count: `Math.ceil(duration / 1800)` (1800s = 30 min)
   - For each chunk, run ffmpeg with `-ss <offset>` and `-t 1800` to extract and compress in one pass
   - Return array of compressed chunks

**Chunk parameters:** 48kbps, mono, 16kHz, MP3 (same as current compression). Each 30-min chunk ~11MB.

### `transcribe-recording.ts`

**Changes to transcription call:**

1. `compressAudioForTranscription()` now returns an array of chunks
2. Loop over chunks sequentially (avoids rate limiting)
3. Concatenate transcription texts with newline separator
4. For `verbose_json`: use detected language from first chunk, pass it as `language` to subsequent chunks
5. For diarized/json formats: simple text concatenation

**Error handling:** If any chunk fails, the whole transcription fails (existing catch-all). No partial saves.

**Cost estimate:** Unchanged — already based on `recording.duration`, not file size.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/transcription/compress-audio.ts` | Return array, add ffprobe + chunked splitting |
| `src/lib/transcription/transcribe-recording.ts` | Loop over chunks, concatenate results |

## Not in scope

- Overlap between chunks (unnecessary complexity; Whisper handles boundaries well)
- Parallel chunk transcription (risk of rate limiting)
- UI progress indicators per chunk
- Partial transcription saves
