import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { buildNotionPageContent } from "@/lib/notion/blocks";
import { createNotionClientFromToken } from "@/lib/notion/client";
import { getNotionConfig } from "@/lib/notion/config";

/**
 * Format duration in milliseconds to a human-readable string like "19m 45s"
 */
function formatDuration(durationMs: number): string {
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${seconds}s`;
}

/**
 * Sync a transcription directly to Notion as a new page in the configured database.
 * Sets properties: Name, Type=Transcript, Bron=Plaud, Status=Inbox,
 * Language, Recorded (date+time), Duration.
 * Page body contains the full transcription text.
 */
export async function syncTranscriptionToNotion(
    transcriptionId: string,
): Promise<void> {
    try {
        const [txn] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, transcriptionId))
            .limit(1);

        if (!txn) {
            console.error(
                "[notion-sync] Transcription not found:",
                transcriptionId,
            );
            return;
        }

        const [recording] = await db
            .select()
            .from(recordings)
            .where(eq(recordings.id, txn.recordingId))
            .limit(1);

        if (!recording) {
            console.error(
                "[notion-sync] Recording not found:",
                txn.recordingId,
            );
            return;
        }

        const config = await getNotionConfig(txn.userId);
        if (!config || !config.enabled) {
            console.log("[notion-sync] Notion not configured or disabled");
            return;
        }

        // Update status to syncing
        await db
            .update(transcriptions)
            .set({ notionSyncStatus: "syncing" })
            .where(eq(transcriptions.id, transcriptionId));

        const notion = createNotionClientFromToken(config.token);

        // Build page properties
        const properties: Record<string, unknown> = {
            Name: {
                title: [{ text: { content: recording.filename } }],
            },
            Type: {
                select: { name: "Transcript" },
            },
            Bron: {
                select: { name: "Plaud" },
            },
            Status: {
                status: { name: "Inbox" },
            },
            Duration: {
                rich_text: [
                    {
                        text: {
                            content: formatDuration(recording.duration),
                        },
                    },
                ],
            },
            Recorded: {
                date: {
                    start: recording.startTime.toISOString(),
                },
            },
        };

        // Add language if detected
        const language = txn.detectedLanguage?.toLowerCase();
        if (language === "dutch" || language === "english") {
            properties.Language = {
                select: { name: language },
            };
        }

        // Build page content blocks (transcription text)
        const blockBatches = buildNotionPageContent({
            title: recording.filename,
            transcriptionText: txn.text,
            recordingUrl: `https://openplaud.maven-company.com/recordings/${recording.id}`,
            duration: recording.duration,
            date: recording.startTime.toISOString(),
            language: txn.detectedLanguage ?? undefined,
            includeSummary: false,
            includeActionItems: false,
        });

        // Create the Notion page with first batch of blocks
        const page = await notion.pages.create({
            parent: { database_id: config.databaseId },
            properties: properties as Parameters<
                typeof notion.pages.create
            >[0]["properties"],
            children: blockBatches[0] ?? [],
        });

        // Append remaining block batches (if transcription is very long)
        for (let i = 1; i < blockBatches.length; i++) {
            await notion.blocks.children.append({
                block_id: page.id,
                children: blockBatches[i],
            });
        }

        // Extract the page URL
        const pageUrl =
            "url" in page ? (page.url as string) : null;

        // Update transcription with success + Notion page reference
        await db
            .update(transcriptions)
            .set({
                notionSyncStatus: "synced",
                notionSyncError: null,
                notionSyncedAt: new Date(),
                notionPageId: page.id,
                notionPageUrl: pageUrl,
            })
            .where(eq(transcriptions.id, transcriptionId));

        console.log(
            `[notion-sync] Synced transcription ${transcriptionId} → ${pageUrl}`,
        );
    } catch (error) {
        console.error("[notion-sync] Failed:", error);

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
            console.error(
                "[notion-sync] Failed to update error status:",
                dbError,
            );
        }
    }
}
