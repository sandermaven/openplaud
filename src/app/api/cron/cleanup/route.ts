import { NextResponse } from "next/server";
import { and, eq, lt, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions, userSettings } from "@/db/schema";
import { createStorageProvider } from "@/lib/storage/factory";
import { env } from "@/lib/env";

export const maxDuration = 300; // 5 minutes

/**
 * Cron endpoint to clean up old recordings based on user retention settings.
 * Deletes audio files from storage and recording rows from the database
 * for users who have autoDeleteRecordings enabled with a retentionDays value.
 *
 * Only recordings that have already been transcribed are deleted.
 */
export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    const url = new URL(request.url);
    const querySecret = url.searchParams.get("secret");
    const token = authHeader?.replace("Bearer ", "") ?? querySecret;

    if (!env.CRON_SECRET || !token || token !== env.CRON_SECRET) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find all users with auto-delete enabled and a retention period set
    const usersWithRetention = await db
        .select({
            userId: userSettings.userId,
            retentionDays: userSettings.retentionDays,
        })
        .from(userSettings)
        .where(
            and(
                eq(userSettings.autoDeleteRecordings, true),
                isNotNull(userSettings.retentionDays),
            ),
        );

    if (usersWithRetention.length === 0) {
        return NextResponse.json({
            success: true,
            message: "No users with auto-delete enabled",
            deletedCount: 0,
        });
    }

    const storage = createStorageProvider();
    let totalDeleted = 0;
    const results: Array<{
        userId: string;
        deleted: number;
        error?: string;
    }> = [];

    for (const { userId, retentionDays } of usersWithRetention) {
        if (!retentionDays || retentionDays < 1) continue;

        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            // Find old recordings that have a transcription (safe to delete)
            const oldRecordings = await db
                .select({
                    id: recordings.id,
                    storagePath: recordings.storagePath,
                })
                .from(recordings)
                .innerJoin(
                    transcriptions,
                    eq(recordings.id, transcriptions.recordingId),
                )
                .where(
                    and(
                        eq(recordings.userId, userId),
                        lt(recordings.startTime, cutoffDate),
                    ),
                );

            let deletedForUser = 0;

            for (const recording of oldRecordings) {
                try {
                    // Try to delete the audio file from storage (may already be gone)
                    try {
                        await storage.deleteFile(recording.storagePath);
                    } catch {
                        // File may already be deleted after transcription - that's fine
                    }

                    // Delete the recording row (transcriptions cascade via FK)
                    await db
                        .delete(recordings)
                        .where(eq(recordings.id, recording.id));

                    deletedForUser++;
                } catch (error) {
                    console.error(
                        `[cron-cleanup] Failed to delete recording ${recording.id}:`,
                        error,
                    );
                }
            }

            totalDeleted += deletedForUser;
            results.push({ userId, deleted: deletedForUser });

            if (deletedForUser > 0) {
                console.log(
                    `[cron-cleanup] Deleted ${deletedForUser} old recording(s) for user ${userId} (retention: ${retentionDays} days)`,
                );
            }
        } catch (error) {
            console.error(
                `[cron-cleanup] Failed for user ${userId}:`,
                error,
            );
            results.push({
                userId,
                deleted: 0,
                error:
                    error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    return NextResponse.json({
        success: true,
        usersProcessed: results.length,
        totalDeleted,
        results,
    });
}
