interface VerifyResult {
    success: boolean;
    databaseTitle?: string;
    error?: string;
}

interface DatabaseProperty {
    type: string;
    name: string;
}

/**
 * Verify a Notion connection by testing the token and database access.
 * Uses raw fetch to the Notion API with a pinned API version (2022-06-28)
 * that returns `properties` on database objects. The SDK v5 defaults to
 * 2025-09-03 which replaced `properties` with `data_sources`.
 */
export async function verifyNotionConnection(
    token: string,
    databaseId: string,
): Promise<VerifyResult> {
    try {
        // Use raw fetch with pinned API version to get properties
        const response = await fetch(
            `https://api.notion.com/v1/databases/${databaseId}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Notion-Version": "2022-06-28",
                },
            },
        );

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            const msg =
                (body as { message?: string }).message || response.statusText;

            if (response.status === 404) {
                return {
                    success: false,
                    error: "Database not found. Check the database ID and ensure the integration has access.",
                };
            }
            if (response.status === 401) {
                return {
                    success: false,
                    error: "Invalid integration token. Check your Notion integration settings.",
                };
            }
            return { success: false, error: msg };
        }

        const database = (await response.json()) as Record<string, unknown>;

        // Check if we got properties
        if (!database.properties || typeof database.properties !== "object") {
            return {
                success: false,
                error: "Could not retrieve database properties. Check integration permissions.",
            };
        }

        // Check required properties exist
        const properties = database.properties as Record<
            string,
            DatabaseProperty
        >;
        const hasTitle = Object.values(properties).some(
            (p) => p.type === "title",
        );
        const hasStatus = Object.values(properties).some(
            (p) => p.type === "status",
        );
        const hasTags = Object.values(properties).some(
            (p) =>
                p.type === "multi_select" &&
                p.name.toLowerCase() === "tags",
        );

        const missingProps: string[] = [];
        if (!hasTitle) missingProps.push("Name (title)");
        if (!hasStatus) missingProps.push("Status");

        if (missingProps.length > 0) {
            return {
                success: false,
                error: `Database is missing required properties: ${missingProps.join(", ")}`,
            };
        }

        // Extract database title
        const titleParts = Array.isArray(database.title)
            ? (database.title as Array<{ plain_text: string }>)
            : [];
        const databaseTitle =
            titleParts.map((t) => t.plain_text).join("") || "Untitled";

        return {
            success: true,
            databaseTitle,
        };
    } catch (error) {
        console.error("Notion verify error:", error);
        if (error instanceof Error) {
            if (error.message.includes("Could not find database")) {
                return {
                    success: false,
                    error: "Database not found. Check the database ID and ensure the integration has access.",
                };
            }
            if (
                error.message.includes("API token is invalid") ||
                error.message.includes("Unauthorized")
            ) {
                return {
                    success: false,
                    error: "Invalid integration token. Check your Notion integration settings.",
                };
            }
            return {
                success: false,
                error: error.message,
            };
        }

        return {
            success: false,
            error: "Failed to connect to Notion",
        };
    }
}
