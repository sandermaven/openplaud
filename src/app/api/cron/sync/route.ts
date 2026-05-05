import { after, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections, userSettings } from "@/db/schema";
import { env } from "@/lib/env";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

export const maxDuration = 300; // 5 minutes

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
        .select({ userId: plaudConnections.userId })
        .from(plaudConnections);

    if (connections.length === 0) {
        return NextResponse.json({ success: true, message: "No users to sync" });
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

    for (const { userId } of connections) {
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

            for (const id of result.pendingTranscriptionIds) {
                allPendingTranscriptions.push({ userId, recordingId: id });
            }

            results.push({
                userId,
                newRecordings: result.newRecordings,
                updatedRecordings: result.updatedRecordings,
                pendingTranscriptions: result.pendingTranscriptionIds.length,
            });
        } catch (error) {
            console.error(`[cron-sync] Failed for user ${userId}:`, error);
            results.push({
                userId,
                newRecordings: 0,
                updatedRecordings: 0,
                pendingTranscriptions: 0,
                error: error instanceof Error ? error.message : "Unknown error",
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
