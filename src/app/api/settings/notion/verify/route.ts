import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getNotionConfig } from "@/lib/notion/config";
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

        // If no token provided, try to use the saved config (DB → env fallback)
        if (!resolvedToken && useSaved) {
            const config = await getNotionConfig(session.user.id);
            if (config) {
                resolvedToken = config.token;
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
