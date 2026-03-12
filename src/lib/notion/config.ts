import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConfig } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { env } from "@/lib/env";

export interface ResolvedNotionConfig {
    token: string;
    databaseId: string;
    enabled: boolean;
    autoSave: boolean;
    defaultTags: string[];
    includeActionItems: boolean;
    includeSummary: boolean;
    language: string;
    /** "db" when loaded from database, "env" when using environment variable fallback */
    source: "db" | "env";
}

/**
 * Get the Notion configuration for a user.
 * First tries the database, then falls back to NOTION_TOKEN / NOTION_DATABASE_ID env vars.
 */
export async function getNotionConfig(
    userId: string,
): Promise<ResolvedNotionConfig | null> {
    // Try database first
    const [config] = await db
        .select()
        .from(notionConfig)
        .where(eq(notionConfig.userId, userId))
        .limit(1);

    if (config) {
        try {
            const token = decrypt(config.encryptedToken);
            return {
                token,
                databaseId: config.databaseId,
                enabled: config.enabled,
                autoSave: config.autoSave,
                defaultTags: (config.defaultTags as string[]) || ["Knowledge"],
                includeActionItems: config.includeActionItems,
                includeSummary: config.includeSummary,
                language: config.language,
                source: "db",
            };
        } catch {
            // Decryption failed (e.g. ENCRYPTION_KEY changed) — fall through to env vars
            console.warn(
                "Notion config decryption failed, trying env var fallback",
            );
        }
    }

    // Fallback to environment variables
    if (env.NOTION_TOKEN && env.NOTION_DATABASE_ID) {
        return {
            token: env.NOTION_TOKEN,
            databaseId: env.NOTION_DATABASE_ID,
            enabled: true,
            autoSave: true,
            defaultTags: ["Knowledge"],
            includeActionItems: true,
            includeSummary: true,
            language: "nl",
            source: "env",
        };
    }

    return null;
}
