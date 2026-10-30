import { and, eq, gte, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
    users,
} from "@/db/schema";
import { env } from "@/lib/env";
import { sendNewRecordingBarkNotification } from "@/lib/notifications/bark";
import { sendNewRecordingEmail } from "@/lib/notifications/email";
import { createPlaudClient } from "@/lib/plaud/client";
import { isAccountMigratedError } from "@/lib/plaud/connection-errors";
import {
    isV4VersionKey,
    recordingIdFromNode,
    toPlaudRecording,
    v4VersionKey,
} from "@/lib/plaud/v4";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { PlaudRecording } from "@/types/plaud";

/**
 * Sync configuration constants
 */
const SYNC_CONFIG = {
    /** Number of recordings to fetch per API call */
    PAGE_SIZE: 50,
    /** Number of recordings to download concurrently */
    BATCH_CONCURRENCY: 2,
    /** Maximum pages to process in a single sync (prevents runaway) */
    MAX_PAGES: 20,
} as const;

/** Skip a recording for one hour after a failed transcription attempt. */
const TRANSCRIPTION_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
/** Give up auto-retrying after this many consecutive failures. */
const TRANSCRIPTION_MAX_FAILURES = 5;
/**
 * Only auto-transcribe recordings made within this window.
 *
 * The queue below asks for every untranscribed recording a user owns, not
 * just the ones this sync brought in, so anything that ever slipped through
 * is retried on every cycle. On an account with hundreds of recordings that
 * is an unbounded, paid backlog that can restart at any time: a storage
 * rewrite, a restored backup or a cleared transcriptions table is enough.
 * Auto-transcription exists for recordings that just arrived, so it stops at
 * a day old. Anything older is transcribed on request from the UI.
 */
const AUTO_TRANSCRIBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SyncResult {
    newRecordings: number;
    updatedRecordings: number;
    errors: string[];
    /** IDs of recordings that need transcription */
    pendingTranscriptionIds: string[];
}

/**
 * Which Plaud API a recording was listed from. It decides how its version
 * is stored, so a legacy version is never compared against a 4.0 one.
 */
type RecordingSource = "legacy" | "v4";

interface SyncContext {
    userId: string;
    autoTranscribe: boolean;
    emailNotifications: boolean;
    barkNotifications: boolean;
    notificationEmail: string | null;
    barkPushUrl: string | null;
}

/**
 * Process a single recording - download and save to database
 */
async function processRecording(
    plaudRecording: PlaudRecording,
    context: SyncContext,
    plaudClient: Awaited<ReturnType<typeof createPlaudClient>>,
    storage: Awaited<ReturnType<typeof createUserStorageProvider>>,
    source: RecordingSource = "legacy",
): Promise<{
    status: "new" | "updated" | "skipped" | "error";
    recordingId?: string;
    filename?: string;
    error?: string;
}> {
    try {
        const [existingRecording] = await db
            .select()
            .from(recordings)
            .where(eq(recordings.plaudFileId, plaudRecording.id))
            .limit(1);

        const versionKey =
            source === "v4"
                ? v4VersionKey(plaudRecording.version_ms)
                : plaudRecording.version_ms.toString();

        // Skip if already synced with same version
        if (
            existingRecording &&
            existingRecording.plaudVersion === versionKey
        ) {
            return { status: "skipped" };
        }

        // Download the audio file
        const audioBuffer = await plaudClient.downloadRecording(
            plaudRecording.id,
            false,
        );

        // The legacy API served MP3; Plaud 4.0 hands back OGG/Opus. Store
        // the container we actually downloaded, otherwise playback and
        // transcription get handed an .mp3 that is not one. The 4.0 mapper
        // puts the audio mime in `filetype`; the legacy API puts something
        // else there, so anything that is not an audio mime stays MP3.
        const contentType = plaudRecording.filetype?.startsWith("audio/")
            ? plaudRecording.filetype
            : "audio/mpeg";
        const fileExtension = contentType === "audio/ogg" ? "ogg" : "mp3";
        const storageKey = `${context.userId}/${plaudRecording.id}.${fileExtension}`;
        await storage.uploadFile(storageKey, audioBuffer, contentType);

        const recordingData = {
            userId: context.userId,
            deviceSn: plaudRecording.serial_number,
            plaudFileId: plaudRecording.id,
            filename: plaudRecording.filename,
            duration: plaudRecording.duration,
            startTime: new Date(plaudRecording.start_time),
            endTime: new Date(plaudRecording.end_time),
            filesize: plaudRecording.filesize,
            fileMd5: plaudRecording.file_md5,
            storageType: env.DEFAULT_STORAGE_TYPE,
            storagePath: storageKey,
            downloadedAt: new Date(),
            plaudVersion: versionKey,
            timezone: plaudRecording.timezone,
            zonemins: plaudRecording.zonemins,
            scene: plaudRecording.scene,
            isTrash: plaudRecording.is_trash,
        };

        if (existingRecording) {
            // Update existing recording
            await db
                .update(recordings)
                .set({ ...recordingData, updatedAt: new Date() })
                .where(eq(recordings.id, existingRecording.id));
            // A re-download can land under a different extension (the
            // legacy API served MP3, 4.0 serves OGG). Nothing else points
            // at the old object once the row moves, so drop it rather than
            // leave an orphan next to the new file.
            if (existingRecording.storagePath !== storageKey) {
                await storage
                    .deleteFile(existingRecording.storagePath)
                    .catch(() => {});
            }
            return {
                status: "updated",
                recordingId: existingRecording.id,
                filename: plaudRecording.filename,
            };
        }

        // Insert new recording
        const [newRecording] = await db
            .insert(recordings)
            .values(recordingData)
            .returning({ id: recordings.id });

        return {
            status: "new",
            recordingId: newRecording.id,
            filename: plaudRecording.filename,
        };
    } catch (error) {
        return {
            status: "error",
            error: `Failed to sync ${plaudRecording.filename}: ${error}`,
        };
    }
}

/**
 * Process a batch of recordings concurrently
 */
async function processBatch(
    batch: PlaudRecording[],
    context: SyncContext,
    plaudClient: Awaited<ReturnType<typeof createPlaudClient>>,
    storage: Awaited<ReturnType<typeof createUserStorageProvider>>,
    source: RecordingSource = "legacy",
): Promise<{
    newCount: number;
    updatedCount: number;
    errors: string[];
    newRecordingIds: string[];
    newRecordingNames: string[];
}> {
    const results = await Promise.allSettled(
        batch.map((rec) =>
            processRecording(rec, context, plaudClient, storage, source),
        ),
    );

    let newCount = 0;
    let updatedCount = 0;
    const errors: string[] = [];
    const newRecordingIds: string[] = [];
    const newRecordingNames: string[] = [];

    for (const result of results) {
        if (result.status === "fulfilled") {
            const { status, recordingId, filename, error } = result.value;
            if (status === "new" && recordingId) {
                newCount++;
                newRecordingIds.push(recordingId);
                if (filename) newRecordingNames.push(filename);
            } else if (status === "updated") {
                updatedCount++;
            } else if (status === "error" && error) {
                errors.push(error);
            }
        } else {
            errors.push(`Batch processing error: ${result.reason}`);
        }
    }

    return {
        newCount,
        updatedCount,
        errors,
        newRecordingIds,
        newRecordingNames,
    };
}

/**
 * Collect the recordings a migrated (Plaud 4.0) account still owes us.
 *
 * The 4.0 listing is a folder tree, so a recording's file id costs an extra
 * two requests to resolve. Listing the nodes is cheap though, and a node
 * carries both its identity and its `version_ms`, which is exactly what the
 * skip check needs. So we list first, drop everything already stored at the
 * same version, and only pay for the rest. On a quiet 15-minute cycle that
 * is one request; a full first run costs two per recording.
 *
 * A recording that predates the migration is already on disk under a legacy
 * version that no 4.0 number will ever equal. Downloading those again would
 * mean re-fetching the entire back catalogue for nothing, so they are
 * returned separately as `restamp`: same recording, new numbering, keep the
 * file. Only after that stamp do 4.0 versions start meaning something, and
 * a genuine edit is picked up from then on.
 */
async function collectMigratedRecordings(
    userId: string,
    plaudClient: Awaited<ReturnType<typeof createPlaudClient>>,
): Promise<{
    records: PlaudRecording[];
    restamp: Array<{ id: string; versionKey: string }>;
    errors: string[];
}> {
    const nodes = await plaudClient.listRecordingNodesV4(
        SYNC_CONFIG.PAGE_SIZE,
        SYNC_CONFIG.MAX_PAGES,
    );
    const errors: string[] = [];
    const restamp: Array<{ id: string; versionKey: string }> = [];
    if (nodes.length === 0) return { records: [], restamp, errors };

    const ids = nodes.map((n) => recordingIdFromNode(n.node_id));
    const stored = await db
        .select({
            plaudFileId: recordings.plaudFileId,
            plaudVersion: recordings.plaudVersion,
            downloadedAt: recordings.downloadedAt,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.userId, userId),
                inArray(recordings.plaudFileId, ids),
            ),
        );
    const storedRows = new Map(stored.map((r) => [r.plaudFileId, r]));

    const records: PlaudRecording[] = [];
    for (const node of nodes) {
        const id = recordingIdFromNode(node.node_id);
        const row = storedRows.get(id);
        const versionKey = v4VersionKey(node.version_ms);

        if (row?.plaudVersion === versionKey) continue;

        // Already downloaded, only ever seen through the legacy API: the
        // audio has not changed, the numbering has. Stamp it and move on.
        if (row?.downloadedAt && !isV4VersionKey(row.plaudVersion)) {
            restamp.push({ id, versionKey });
            continue;
        }

        try {
            const fileId = await plaudClient.resolveFileIdV4(node.node_id);
            const detail = await plaudClient.getFileDetailV4(fileId);
            records.push(toPlaudRecording(node, detail.data));
        } catch (error) {
            errors.push(`Failed to resolve ${node.name}: ${error}`);
        }
    }

    return { records, restamp, errors };
}

/**
 * Sync recordings for a user with optimized batch processing
 *
 * Optimizations:
 * - Fetches recordings in pages (50 at a time)
 * - Downloads concurrently in batches (5 at a time)
 * - Queues transcription for after sync completes
 * - Stops early if no new recordings found
 */
export async function syncRecordingsForUser(
    userId: string,
): Promise<SyncResult> {
    const result: SyncResult = {
        newRecordings: 0,
        updatedRecordings: 0,
        errors: [],
        pendingTranscriptionIds: [],
    };

    try {
        // Get connection
        const [connection] = await db
            .select()
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, userId))
            .limit(1);

        if (!connection) {
            result.errors.push("No Plaud connection found");
            return result;
        }

        // Get user settings
        const [settings] = await db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);

        const [user] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        const context: SyncContext = {
            userId,
            autoTranscribe: settings?.autoTranscribe ?? false,
            emailNotifications: settings?.emailNotifications ?? false,
            barkNotifications: settings?.barkNotifications ?? false,
            notificationEmail:
                settings?.notificationEmail || user?.email || null,
            barkPushUrl: settings?.barkPushUrl || null,
        };

        const plaudClient = await createPlaudClient(
            connection.bearerToken,
            connection.apiBase,
            {
                connectionId: connection.id,
                encryptedRefreshToken: connection.refreshToken,
            },
        );
        const storage = await createUserStorageProvider(userId);
        const allNewRecordingNames: string[] = [];

        const runBatches = async (
            list: PlaudRecording[],
            source: RecordingSource = "legacy",
        ) => {
            for (
                let i = 0;
                i < list.length;
                i += SYNC_CONFIG.BATCH_CONCURRENCY
            ) {
                const batch = list.slice(i, i + SYNC_CONFIG.BATCH_CONCURRENCY);
                const batchResult = await processBatch(
                    batch,
                    context,
                    plaudClient,
                    storage,
                    source,
                );

                result.newRecordings += batchResult.newCount;
                result.updatedRecordings += batchResult.updatedCount;
                result.errors.push(...batchResult.errors);
                result.pendingTranscriptionIds.push(
                    ...batchResult.newRecordingIds,
                );
                allNewRecordingNames.push(...batchResult.newRecordingNames);
            }
        };

        // Paginated sync - fetch newest first
        let page = 0;
        let hasMore = true;
        let consecutiveEmptyPages = 0;
        let migrated = false;

        while (hasMore && page < SYNC_CONFIG.MAX_PAGES) {
            const skip = page * SYNC_CONFIG.PAGE_SIZE;

            let plaudRecordings: PlaudRecording[];
            try {
                const recordingsResponse = await plaudClient.getRecordings(
                    skip,
                    SYNC_CONFIG.PAGE_SIZE,
                    0, // not trash
                    "edit_time",
                    true, // descending (newest first)
                );
                plaudRecordings = recordingsResponse.data_file_list;
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                // Plaud moved this account to 4.0 and retired the legacy
                // file endpoints for it. Nothing here will ever succeed
                // again, so hand the whole sync to the 4.0 path.
                if (isAccountMigratedError(message)) {
                    migrated = true;
                    break;
                }
                throw error;
            }

            if (plaudRecordings.length === 0) {
                break;
            }

            await runBatches(plaudRecordings);

            // Early exit optimization: if we got fewer recordings than requested,
            // or if we had no new/updated recordings for 2 pages, we're done
            if (plaudRecordings.length < SYNC_CONFIG.PAGE_SIZE) {
                hasMore = false;
            } else if (
                result.newRecordings === 0 &&
                result.updatedRecordings === 0
            ) {
                consecutiveEmptyPages++;
                if (consecutiveEmptyPages >= 2) {
                    hasMore = false;
                }
            } else {
                consecutiveEmptyPages = 0;
            }

            page++;
        }

        if (migrated) {
            const { records, restamp, errors } =
                await collectMigratedRecordings(userId, plaudClient);
            result.errors.push(...errors);
            for (const { id, versionKey } of restamp) {
                await db
                    .update(recordings)
                    .set({ plaudVersion: versionKey })
                    .where(
                        and(
                            eq(recordings.userId, userId),
                            eq(recordings.plaudFileId, id),
                        ),
                    );
            }
            await runBatches(records, "v4");
        }

        // Update last sync time. If the client auto-redirected to a
        // region-specific domain, persist the corrected base so future
        // syncs skip the redirect round-trip.
        const resolvedApiBase = plaudClient.getApiBase();
        await db
            .update(plaudConnections)
            .set({
                lastSync: new Date(),
                ...(resolvedApiBase !== connection.apiBase
                    ? { apiBase: resolvedApiBase }
                    : {}),
            })
            .where(eq(plaudConnections.id, connection.id));

        // Send notifications
        if (
            context.emailNotifications &&
            context.notificationEmail &&
            result.newRecordings > 0
        ) {
            try {
                await sendNewRecordingEmail(
                    context.notificationEmail,
                    result.newRecordings,
                    allNewRecordingNames,
                );
            } catch (error) {
                console.error("Failed to send email notification:", error);
                result.errors.push("Email notification failed");
            }
        }

        if (
            context.barkNotifications &&
            context.barkPushUrl &&
            result.newRecordings > 0
        ) {
            try {
                const success = await sendNewRecordingBarkNotification(
                    context.barkPushUrl,
                    result.newRecordings,
                    allNewRecordingNames,
                );
                if (!success) {
                    result.errors.push("Bark notification failed or timed out");
                }
            } catch (error) {
                console.error("Failed to send Bark notification:", error);
                result.errors.push("Bark notification failed");
            }
        }

        // Collect IDs of recordings that need transcription. Skip ones that
        // failed too recently (cooldown) or exceeded the failure cap, so a
        // persistent error (quota, rate limit, invalid input) doesn't generate
        // a retry-storm.
        if (context.autoTranscribe) {
            const transcribedRecordingIds = db
                .select({ recordingId: transcriptions.recordingId })
                .from(transcriptions)
                .where(eq(transcriptions.userId, userId));

            const cooldown = new Date(
                Date.now() - TRANSCRIPTION_FAILURE_COOLDOWN_MS,
            );
            const oldestAutoTranscribable = new Date(
                Date.now() - AUTO_TRANSCRIBE_MAX_AGE_MS,
            );

            const untranscribed = await db
                .select({ id: recordings.id })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.userId, userId),
                        notInArray(recordings.id, transcribedRecordingIds),
                        gte(recordings.startTime, oldestAutoTranscribable),
                        lt(
                            recordings.transcriptionFailureCount,
                            TRANSCRIPTION_MAX_FAILURES,
                        ),
                        or(
                            isNull(recordings.lastTranscriptionAttemptAt),
                            lt(recordings.lastTranscriptionAttemptAt, cooldown),
                        ),
                    ),
                );

            result.pendingTranscriptionIds = untranscribed.map((r) => r.id);
        }

        return result;
    } catch (error) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        result.errors.push(`Sync failed: ${errorMessage}`);
        return result;
    }
}
