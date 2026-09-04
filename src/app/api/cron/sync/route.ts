import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { plaudConnections, userSettings, users } from "@/db/schema";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/notifications/email";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import {
    enqueueTranscription,
    getTranscriptionJobState,
} from "@/lib/transcription/queue";

export const maxDuration = 300; // 5 minutes

/** Only re-notify a user about an expired connection once per 12 hours. */
const CONNECTION_ERROR_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

const RECONNECT_PATH = "/onboarding?reconnect=1";

/**
 * True when a sync failure means the per-account Plaud bearer token is no
 * longer valid (Plaud returns app-level status -419 for this). Reconnecting
 * is the only fix, so these get the dashboard banner + email.
 */
function isConnectionExpiredError(message: string): boolean {
    const m = message.toLowerCase();
    return (
        m.includes("-419") ||
        m.includes("token expired") ||
        m.includes("workspace token")
    );
}

type SyncConnection = {
    id: string;
    userId: string;
    syncError: string | null;
    syncErrorAt: Date | null;
};

/**
 * Persist a connection-expired failure and email the user once per cooldown.
 * The existing syncErrorAt is kept while inside the cooldown so the 12h window
 * is measured from the first notification, not from every failing run.
 */
async function recordConnectionError(
    connection: SyncConnection,
    message: string,
): Promise<void> {
    const now = new Date();
    const shouldNotify =
        !connection.syncErrorAt ||
        now.getTime() - connection.syncErrorAt.getTime() >
            CONNECTION_ERROR_NOTIFY_COOLDOWN_MS;

    await db
        .update(plaudConnections)
        .set({
            syncError: message,
            ...(shouldNotify ? { syncErrorAt: now } : {}),
        })
        .where(eq(plaudConnections.id, connection.id));

    if (!shouldNotify) return;

    const [settings] = await db
        .select({ notificationEmail: userSettings.notificationEmail })
        .from(userSettings)
        .where(eq(userSettings.userId, connection.userId))
        .limit(1);
    const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, connection.userId))
        .limit(1);

    const to = settings?.notificationEmail || user?.email;
    if (!to) return;

    const url = `${env.APP_URL}${RECONNECT_PATH}`;
    const text = `Je Plaud-koppeling is verlopen; transcripties komen niet binnen. Herstel via ${RECONNECT_PATH}`;
    await sendEmail({
        to,
        subject: "Je Plaud-koppeling is verlopen",
        html: `<p>Je Plaud-koppeling is verlopen; transcripties komen niet binnen. Herstel via <a href="${url}">${RECONNECT_PATH}</a>.</p>`,
        text,
    });
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
    const connections = await db
        .select({
            id: plaudConnections.id,
            userId: plaudConnections.userId,
            syncError: plaudConnections.syncError,
            syncErrorAt: plaudConnections.syncErrorAt,
        })
        .from(plaudConnections);

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
            if (!autoSyncEnabled) continue;

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

    // Hand pending work to the background queue, which dedupes on recording id
    // and runs one job at a time. Every sync re-reports *all* untranscribed
    // recordings, so without that dedupe each cron run would stack another copy
    // of the same backlog. Cleanup is owned by /api/cron/cleanup (daily) — do
    // NOT inline it here, otherwise the destructive row-delete runs every 15
    // minutes and re-triggers the Plaud-resync-then-retranscribe loop.
    let queued = 0;
    for (const { userId, recordingId } of allPendingTranscriptions) {
        const before = getTranscriptionJobState(recordingId).status;
        enqueueTranscription(userId, recordingId);
        if (before === "idle") queued++;
    }
    if (queued > 0) {
        console.log(
            `[cron-sync] Queued ${queued} of ${allPendingTranscriptions.length} pending recording(s)`,
        );
    }

    return NextResponse.json({
        success: true,
        usersProcessed: results.length,
        totalNewRecordings: results.reduce((s, r) => s + r.newRecordings, 0),
        totalPendingTranscriptions: allPendingTranscriptions.length,
        queuedTranscriptions: queued,
        results,
    });
}
