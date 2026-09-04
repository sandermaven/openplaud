import {
    type TranscribeOptions,
    transcribeRecording,
} from "@/lib/transcription/transcribe-recording";

/**
 * Single-worker transcription queue.
 *
 * Two things make this necessary:
 *
 * 1. ffmpeg + Whisper on a 1GB e2-micro OOM-cascades when two transcriptions
 *    run at once, so the work has to be serialized.
 * 2. Every sync (browser every 5 minutes, cron on its own schedule) collects
 *    *all* untranscribed recordings for the user, not just the new ones. Without
 *    dedupe each sync pushes the same recordings onto the queue again, so it
 *    grows faster than it drains and a user-triggered job ends up behind hours
 *    of duplicates.
 *
 * Deduping on recordingId fixes (2); running one worker keeps (1).
 *
 * State is deliberately in-memory only: a restart wipes the queue, and the
 * status the UI polls then reports "idle" — which is true, because the job
 * really is gone. A database column would instead be stuck on "running"
 * forever after a crash.
 */

export type TranscriptionJobStatus = "idle" | "queued" | "running";

export interface TranscriptionJobState {
    status: TranscriptionJobStatus;
    /** 1-based place in line while queued; 0 while running or idle. */
    position: number;
    /** How long the job has been running, in ms. Only set while running. */
    runningForMs?: number;
    /** Total jobs waiting or running, across all recordings. */
    queueLength: number;
    /** Failure from the most recent finished run, if it failed. */
    error?: string;
}

export interface EnqueueOptions extends TranscribeOptions {
    /**
     * Jump ahead of background work. Set this for anything a person is waiting
     * on: auto-transcribe can hand the queue a backlog of dozens of recordings,
     * and a user's click sitting behind all of them is exactly the "it hangs"
     * this queue exists to prevent.
     */
    priority?: boolean;
}

interface QueueEntry {
    userId: string;
    recordingId: string;
    options: TranscribeOptions;
    priority: boolean;
}

/**
 * Abandon a job that runs longer than this so one wedged transcription can't
 * block the queue indefinitely. The underlying promise may still be running —
 * we can't kill it — but the worker moves on.
 */
const JOB_TIMEOUT_MS = 45 * 60 * 1000;

/** Cap on remembered failures, so an unattended backlog can't grow unbounded. */
const MAX_REMEMBERED_ERRORS = 200;

const queue: QueueEntry[] = [];
/** recordingId -> entry, for O(1) dedupe against what's already waiting. */
const queued = new Map<string, QueueEntry>();
/** Errors from finished runs, so the polling client can surface them once. */
const lastErrors = new Map<string, string>();

function rememberError(recordingId: string, message: string): void {
    lastErrors.set(recordingId, message);
    while (lastErrors.size > MAX_REMEMBERED_ERRORS) {
        // Map iterates in insertion order, so this drops the oldest.
        const oldest = lastErrors.keys().next().value;
        if (oldest === undefined) break;
        lastErrors.delete(oldest);
    }
}

let active: { entry: QueueEntry; startedAt: number } | null = null;
let workerRunning = false;

function totalPending(): number {
    return queue.length + (active ? 1 : 0);
}

/**
 * Combine a new request with one that's already waiting. A forced re-transcribe
 * must never be swallowed by a pending auto-transcribe, and the newest explicit
 * language wins.
 */
function mergeOptions(
    existing: TranscribeOptions,
    incoming: TranscribeOptions,
): TranscribeOptions {
    return {
        force: existing.force || incoming.force,
        languageOverride:
            incoming.languageOverride ?? existing.languageOverride ?? null,
    };
}

/** Insert respecting priority: priority jobs first, FIFO within each group. */
function insert(entry: QueueEntry): void {
    if (!entry.priority) {
        queue.push(entry);
        return;
    }
    const firstBackground = queue.findIndex((e) => !e.priority);
    if (firstBackground === -1) queue.push(entry);
    else queue.splice(firstBackground, 0, entry);
}

export function getTranscriptionJobState(
    recordingId: string,
): TranscriptionJobState {
    const queueLength = totalPending();

    if (active?.entry.recordingId === recordingId) {
        return {
            status: "running",
            position: 0,
            runningForMs: Date.now() - active.startedAt,
            queueLength,
        };
    }

    const index = queue.findIndex((e) => e.recordingId === recordingId);
    if (index >= 0) {
        return { status: "queued", position: index + 1, queueLength };
    }

    const error = lastErrors.get(recordingId);
    return {
        status: "idle",
        position: 0,
        queueLength,
        ...(error && { error }),
    };
}

/** Drop a remembered failure once the client has been told about it. */
export function clearTranscriptionError(recordingId: string): void {
    lastErrors.delete(recordingId);
}

/**
 * Put a recording in line for transcription. Returns immediately — callers must
 * not await the transcription itself, that's what wedged the request handlers.
 *
 * Enqueueing a recording that's already queued merges the options instead of
 * adding a second job.
 */
export function enqueueTranscription(
    userId: string,
    recordingId: string,
    options: EnqueueOptions = {},
): TranscriptionJobState {
    lastErrors.delete(recordingId);
    const { priority = false, ...transcribeOptions } = options;

    const waiting = queued.get(recordingId);
    if (waiting) {
        waiting.options = mergeOptions(waiting.options, transcribeOptions);
        // A background job someone is now waiting on moves up the queue.
        const index =
            priority && !waiting.priority ? queue.indexOf(waiting) : -1;
        if (index >= 0) {
            waiting.priority = true;
            queue.splice(index, 1);
            insert(waiting);
        }
        return getTranscriptionJobState(recordingId);
    }

    if (active?.entry.recordingId === recordingId) {
        // Already running. Only line it up again when this request asks for
        // something the running job isn't doing, i.e. a forced overwrite.
        if (!transcribeOptions.force || active.entry.options.force) {
            return getTranscriptionJobState(recordingId);
        }
    }

    const entry: QueueEntry = {
        userId,
        recordingId,
        options: { ...transcribeOptions },
        priority,
    };
    insert(entry);
    queued.set(recordingId, entry);

    const state = getTranscriptionJobState(recordingId);
    // Start after this tick so the state we just computed still describes the
    // job as queued rather than racing the worker picking it up.
    queueMicrotask(startWorker);
    return state;
}

/** Queue several recordings at once. Returns how many were actually added. */
export function enqueueTranscriptions(
    userId: string,
    recordingIds: string[],
    options: EnqueueOptions = {},
): number {
    let added = 0;
    for (const recordingId of recordingIds) {
        const before = totalPending();
        enqueueTranscription(userId, recordingId, options);
        if (totalPending() > before) added++;
    }
    return added;
}

function startWorker(): void {
    if (workerRunning) return;
    workerRunning = true;
    void runWorker();
}

function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `Transcription for ${label} exceeded ${Math.round(ms / 60_000)} minutes`,
                ),
            );
        }, ms);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

async function runWorker(): Promise<void> {
    try {
        while (true) {
            const entry = queue.shift();
            if (!entry) return;

            queued.delete(entry.recordingId);
            active = { entry, startedAt: Date.now() };

            try {
                const result = await withTimeout(
                    transcribeRecording(
                        entry.userId,
                        entry.recordingId,
                        entry.options,
                    ),
                    JOB_TIMEOUT_MS,
                    entry.recordingId,
                );

                if (result.success) {
                    console.log(
                        `[transcribe-queue] Completed ${entry.recordingId} (${queue.length} left)`,
                    );
                } else {
                    const error = result.error ?? "Transcription failed";
                    rememberError(entry.recordingId, error);
                    console.error(
                        `[transcribe-queue] Failed ${entry.recordingId}: ${error}`,
                    );
                }
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : "Transcription failed";
                rememberError(entry.recordingId, message);
                console.error(
                    `[transcribe-queue] Failed ${entry.recordingId}: ${message}`,
                );
            } finally {
                active = null;
            }
        }
    } finally {
        workerRunning = false;
    }
}

/** Test hook: drop all queued work and remembered errors. */
export function resetTranscriptionQueue(): void {
    queue.length = 0;
    queued.clear();
    lastErrors.clear();
    active = null;
}
