import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { env } from "@/lib/env";

const SCRIBE_WEBHOOK_URL =
    "https://cal-agent-production.up.railway.app/scribe/webhook";

/**
 * Sync a transcription to Scribe. Scribe enriches the transcript and
 * creates the Notion page. Non-blocking: catches all errors internally.
 */
export async function syncTranscriptionToNotion(
    transcriptionId: string,
): Promise<void> {
    try {
        const secret = env.SCRIBE_WEBHOOK_SECRET;
        if (!secret) {
            console.error("Scribe sync: SCRIBE_WEBHOOK_SECRET not configured");
            return;
        }

        // Fetch transcription
        const [txn] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, transcriptionId))
            .limit(1);

        if (!txn) {
            console.error("Scribe sync: transcription not found", transcriptionId);
            return;
        }

        // Fetch recording
        const [recording] = await db
            .select()
            .from(recordings)
            .where(eq(recordings.id, txn.recordingId))
            .limit(1);

        if (!recording) {
            console.error("Scribe sync: recording not found", txn.recordingId);
            return;
        }

        // Update status to syncing
        await db
            .update(transcriptions)
            .set({ notionSyncStatus: "syncing" })
            .where(eq(transcriptions.id, transcriptionId));

        // Send raw transcript to Scribe
        const payload = {
            title: recording.filename,
            transcript: txn.text,
            recordingDate: recording.startTime.toISOString(),
        };

        const response = await fetch(SCRIBE_WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Webhook-Secret": secret,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(
                `Scribe webhook returned ${response.status}: ${body}`,
            );
        }

        // Update transcription with success
        await db
            .update(transcriptions)
            .set({
                notionSyncStatus: "synced",
                notionSyncError: null,
                notionSyncedAt: new Date(),
            })
            .where(eq(transcriptions.id, transcriptionId));
    } catch (error) {
        console.error("Scribe sync failed:", error);

        try {
            await db
                .update(transcriptions)
                .set({
                    notionSyncStatus: "failed",
                    notionSyncError:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                })
                .where(eq(transcriptions.id, transcriptionId));
        } catch (dbError) {
            console.error("Failed to update sync error status:", dbError);
        }
    }
}
