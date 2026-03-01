import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { notionConfig } from "@/db/schema";
import { auth } from "@/lib/auth";
import { decrypt } from "@/lib/encryption";
import { verifyNotionConnection } from "@/lib/notion/verify";

// POST - Verify Notion connection
export async function POST(request: Request) {
    try {
        const session = await auth.api.getSession({
            headers: request.headers,
        });

        if (!session?.user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }

        const { token, databaseId, useSaved } = await request.json();

        let resolvedToken = token;
        let resolvedDatabaseId = databaseId;

        // If no token provided, try to use the saved one
        if (!resolvedToken && useSaved) {
            const [config] = await db
                .select()
                .from(notionConfig)
                .where(eq(notionConfig.userId, session.user.id))
                .limit(1);

            if (config) {
                resolvedToken = decrypt(config.encryptedToken);
                if (!resolvedDatabaseId) {
                    resolvedDatabaseId = config.databaseId;
                }
            }
        }

        if (!resolvedToken || !resolvedDatabaseId) {
            return NextResponse.json(
                { success: false, error: "Token and database ID are required" },
                { status: 400 },
            );
        }

        const result = await verifyNotionConnection(
            resolvedToken,
            resolvedDatabaseId,
        );

        return NextResponse.json(result);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : String(error);
        console.error("Error verifying Notion connection:", message, error);
        return NextResponse.json(
            {
                success: false,
                error: `Failed to verify Notion connection: ${message}`,
            },
            { status: 500 },
        );
    }
}
