import { eq } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import { db } from "@/db";
import { plaudConnections, userSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { alertConnectionProblem } from "@/lib/plaud/connection-alerts";
import { isConnectionExpiredError } from "@/lib/plaud/connection-errors";
import { refreshIfDue } from "@/lib/plaud/refresh";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

export const maxDuration = 300; // 5 minutes

type SyncConnection = typeof plaudConnections.$inferSelect;

/**
 * Persist a connection-expired failure for the dashboard banner and mail the
 * user. The mail is rate-limited to one a day inside alertConnectionProblem.
 */
async function recordConnectionError(
    connection: SyncConnection,
    message: string,
): Promise<void> {
    await db
        .update(plaudConnections)
        .set({
            syncError: message,
            ...(connection.syncErrorAt ? {} : { syncErrorAt: new Date() }),
        })
        .where(eq(plaudConnections.id, connection.id));

    await alertConnectionProblem(connection.id, "expired");
}

/** Clear a previously stored connection error after a healthy sync. */
async function clearConnectionError(connection: SyncConnection): Promise<void> {
    if (!connection.syncError && !connection.syncErrorAt) return;
    await db
        .update(plaudConnections)
        .set({ syncError: null, syncErrorAt: null })
        .where(eq(plaudConnections.id, connection.id));
}

export async function GET(request: Request) {
    // Authenticate via CRON_SECRET (bearer token or query param)
    const authHeader = request.headers.get("authorization");
    const url = new URL(request.url);
    const querySecret = url.searchParams.get("secret");
    const token = authHeader?.replace("Bearer ", "") ?? querySecret;

    if (!env.CRON_SECRET || !token || token !== env.CRON_SECRET) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find all users with a Plaud connection
    const connections = await db.select().from(plaudConnections);

    if (connections.length === 0) {
        return NextResponse.json({
            success: true,
            message: "No users to sync",
        });
    }

    const results: Array<{
        userId: string;
        newRecordings: number;
        updatedRecordings: number;
        pendingTranscriptions: number;
        error?: string;
    }> = [];

    const allPendingTranscriptions: Array<{
        userId: string;
        recordingId: string;
    }> = [];

    for (const connection of connections) {
        const { userId } = connection;
        try {
            // Check if user has auto-sync enabled (default: true)
            const settings = await db
                .select({ autoSyncEnabled: userSettings.autoSyncEnabled })
                .from(userSettings)
                .where(eq(userSettings.userId, userId))
                .limit(1);

            const autoSyncEnabled = settings[0]?.autoSyncEnabled ?? true;
            if (!autoSyncEnabled) {
                // No sync, but keep the tokens alive: once the refresh token
                // lapses only a manual reconnect brings the connection back.
                await refreshIfDue(connection);
                continue;
            }

            const result = await syncRecordingsForUser(userId);

            // syncRecordingsForUser swallows the Plaud API failure and returns
            // it in `errors` rather than throwing, so inspect the messages to
            // catch an expired bearer token.
            const expiredError = result.errors.find(isConnectionExpiredError);
            if (expiredError) {
                await recordConnectionError(connection, expiredError);
            } else {
                await clearConnectionError(connection);
            }

            for (const id of result.pendingTranscriptionIds) {
                allPendingTranscriptions.push({ userId, recordingId: id });
            }

            results.push({
                userId,
                newRecordings: result.newRecordings,
                updatedRecordings: result.updatedRecordings,
                pendingTranscriptions: result.pendingTranscriptionIds.length,
                error: expiredError,
            });
        } catch (error) {
            console.error(`[cron-sync] Failed for user ${userId}:`, error);
            const message =
                error instanceof Error ? error.message : "Unknown error";
            if (isConnectionExpiredError(message)) {
                await recordConnectionError(connection, message);
            }
            results.push({
                userId,
                newRecordings: 0,
                updatedRecordings: 0,
                pendingTranscriptions: 0,
                error: message,
            });
        }
    }

    // Transcribe pending recordings after the response is sent. Cleanup is
    // owned by /api/cron/cleanup (daily) — do NOT inline it here, otherwise
    // the destructive row-delete runs every 15 minutes and re-triggers the
    // Plaud-resync-then-retranscribe loop.
    after(async () => {
        if (allPendingTranscriptions.length > 0) {
            console.log(
                `[cron-sync] Starting transcription for ${allPendingTranscriptions.length} recording(s)`,
            );
            for (const { userId, recordingId } of allPendingTranscriptions) {
                const res = await transcribeRecording(userId, recordingId);
                if (!res.success) {
                    console.error(
                        `[cron-sync] Transcription failed for ${recordingId}: ${res.error}`,
                    );
                } else {
                    console.log(
                        `[cron-sync] Transcription completed ${recordingId}`,
                    );
                }
            }
        }
    });

    return NextResponse.json({
        success: true,
        usersProcessed: results.length,
        totalNewRecordings: results.reduce((s, r) => s + r.newRecordings, 0),
        totalPendingTranscriptions: allPendingTranscriptions.length,
        results,
    });
}
