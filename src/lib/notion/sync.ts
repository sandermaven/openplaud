import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    recordings,
    transcriptions,
} from "@/db/schema";
import { generateSummaryFromTranscription } from "@/lib/ai/generate-summary";
import { env } from "@/lib/env";
import { notifyCalWebhook } from "@/lib/notion/cal-notify";
import { buildNotionPageContent } from "./blocks";
import { createNotionClientFromToken } from "./client";
import { getNotionConfig } from "./config";

const RATE_LIMIT_DELAY = 350; // ms between API calls (3 req/s limit)

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Desired metadata properties and their Notion types.
 * These will be auto-created on the database if missing.
 */
const METADATA_PROPERTIES: Record<string, Record<string, unknown>> = {
    Date: { date: {} },
    Duration: { rich_text: {} },
    Language: { select: {} },
};

/**
 * Ensure the Notion database has the required metadata properties.
 * Uses raw fetch with pinned API version (2022-06-28) because the SDK v5
 * defaults to 2025-09-03 which removed `properties` from database endpoints.
 */
async function ensureDatabaseProperties(
    token: string,
    databaseId: string,
): Promise<void> {
    // Retrieve existing properties
    const getRes = await fetch(
        `https://api.notion.com/v1/databases/${databaseId}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                "Notion-Version": "2022-06-28",
            },
        },
    );

    if (!getRes.ok) return; // non-critical — page creation will still work

    const database = (await getRes.json()) as {
        properties?: Record<string, unknown>;
    };
    const existing = database.properties
        ? Object.keys(database.properties)
        : [];

    const missing: Record<string, Record<string, unknown>> = {};
    for (const [name, schema] of Object.entries(METADATA_PROPERTIES)) {
        if (!existing.includes(name)) {
            missing[name] = schema;
        }
    }

    if (Object.keys(missing).length === 0) return;

    await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties: missing }),
    });
}

/**
 * Sync a transcription to Notion. Non-blocking: catches all errors internally.
 */
export async function syncTranscriptionToNotion(
    transcriptionId: string,
): Promise<void> {
    try {
        // Fetch transcription with recording data
        const [txn] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.id, transcriptionId))
            .limit(1);

        if (!txn) {
            console.error("Notion sync: transcription not found", transcriptionId);
            return;
        }

        // Fetch recording
        const [recording] = await db
            .select()
            .from(recordings)
            .where(eq(recordings.id, txn.recordingId))
            .limit(1);

        if (!recording) {
            console.error("Notion sync: recording not found", txn.recordingId);
            return;
        }

        // Fetch AI enhancement (if exists)
        const [enhancement] = await db
            .select()
            .from(aiEnhancements)
            .where(eq(aiEnhancements.recordingId, txn.recordingId))
            .limit(1);

        // Fetch notion config (DB first, then env var fallback)
        const config = await getNotionConfig(txn.userId);

        if (!config || !config.enabled) {
            return;
        }

        // Update status to syncing
        await db
            .update(transcriptions)
            .set({ notionSyncStatus: "syncing" })
            .where(eq(transcriptions.id, transcriptionId));

        const client = createNotionClientFromToken(config.token);

        const appUrl = env.APP_URL || "http://localhost:3000";
        const recordingUrl = `${appUrl}/recordings/${recording.id}`;

        // Create page properties
        const properties: Record<string, unknown> = {
            Name: {
                title: [
                    {
                        text: {
                            content: recording.filename,
                        },
                    },
                ],
            },
            Status: {
                status: {
                    name: "Inbox",
                },
            },
            URL: {
                url: recordingUrl,
            },
        };

        // Ensure metadata properties exist on the Notion database
        await ensureDatabaseProperties(config.token, config.databaseId);
        await delay(RATE_LIMIT_DELAY);

        // Tags (may not exist — retry without if creation fails)
        if (config.defaultTags && config.defaultTags.length > 0) {
            properties.Tags = {
                multi_select: config.defaultTags.map((tag: string) => ({
                    name: tag,
                })),
            };
        }

        // Date (recording start time)
        properties.Date = {
            date: {
                start: recording.startTime.toISOString(),
            },
        };

        // Duration (formatted as "mm:ss")
        const durationMs = recording.duration;
        const minutes = Math.floor(durationMs / 60000);
        const seconds = Math.floor((durationMs % 60000) / 1000);
        properties.Duration = {
            rich_text: [
                {
                    type: "text",
                    text: {
                        content: `${minutes}:${seconds.toString().padStart(2, "0")}`,
                    },
                },
            ],
        };

        // Language
        const detectedLanguage = txn.detectedLanguage || config.language;
        if (detectedLanguage) {
            properties.Language = {
                select: { name: detectedLanguage },
            };
        }

        // Create page (retry without Tags if that property doesn't exist)
        let page;
        try {
            page = await client.pages.create({
                parent: { database_id: config.databaseId },
                properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
            });
        } catch (createError) {
            const msg = createError instanceof Error ? createError.message : "";
            if (properties.Tags && msg.includes("Tags")) {
                delete properties.Tags;
                page = await client.pages.create({
                    parent: { database_id: config.databaseId },
                    properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
                });
            } else {
                throw createError;
            }
        }

        // Generate summary if configured and no existing enhancement summary
        let summary: string | null = enhancement?.summary ?? null;
        if (config.includeSummary && !summary && config.summaryPrompt) {
            summary = await generateSummaryFromTranscription(
                txn.userId,
                txn.text,
                config.summaryPrompt,
            );
        }

        // Build content blocks
        const actionItems =
            enhancement?.actionItems &&
            Array.isArray(enhancement.actionItems)
                ? (enhancement.actionItems as string[])
                : null;

        const batches = buildNotionPageContent({
            title: recording.filename,
            transcriptionText: txn.text,
            summary: config.includeSummary ? summary : null,
            actionItems: config.includeActionItems ? actionItems : null,
            recordingUrl,
            duration: recording.duration,
            date: recording.startTime.toISOString(),
            language: txn.detectedLanguage || config.language,
            includeSummary: config.includeSummary,
            includeActionItems: config.includeActionItems,
        });

        // Append blocks in batches with rate limiting
        for (const batch of batches) {
            await client.blocks.children.append({
                block_id: page.id,
                children: batch,
            });
            await delay(RATE_LIMIT_DELAY);
        }

        // Extract page URL
        const pageUrl =
            "url" in page ? (page.url as string) : null;

        // Update transcription with success
        await db
            .update(transcriptions)
            .set({
                notionPageId: page.id,
                notionPageUrl: pageUrl,
                notionSyncStatus: "synced",
                notionSyncError: null,
                notionSyncedAt: new Date(),
            })
            .where(eq(transcriptions.id, transcriptionId));

        // Notify Cal so it can send a Telegram message
        notifyCalWebhook({
            title: recording.filename,
            notionPageUrl: pageUrl ?? "",
            summary: summary ?? undefined,
            recordingDate: recording.startTime.toISOString(),
        });
    } catch (error) {
        console.error("Notion sync failed:", error);

        // Update transcription with failure
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
