import { NextResponse } from "next/server";
import { and, eq, lt, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions, userSettings } from "@/db/schema";
import { createStorageProvider } from "@/lib/storage/factory";
import { env } from "@/lib/env";

export const maxDuration = 300; // 5 minutes

/**
 * Cron endpoint to clean up old recordings based on user retention settings.
 * Deletes the audio file from storage but keeps the recording + transcription
 * rows. The Plaud server retains the original audio long after we expire it
 * locally, so removing the row would let the next sync pull the file back as
 * "new" and re-trigger transcription — burning OpenAI credit and producing
 * duplicate Notion pages. Keeping the row preserves the plaud_file_id as a
 * dedup key.
 *
 * Only recordings that have already been transcribed are touched.
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

            let cleanedForUser = 0;

            for (const recording of oldRecordings) {
                try {
                    await storage.deleteFile(recording.storagePath);
                    cleanedForUser++;
                } catch {
                    // File may already be gone after transcription — fine.
                }
            }

            totalDeleted += cleanedForUser;
            results.push({ userId, deleted: cleanedForUser });

            if (cleanedForUser > 0) {
                console.log(
                    `[cron-cleanup] Removed audio for ${cleanedForUser} old recording(s) for user ${userId} (retention: ${retentionDays} days; rows preserved)`,
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
