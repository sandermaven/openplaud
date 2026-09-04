import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";

/**
 * Rotates the short-lived Plaud workspace access token using the long-lived
 * refresh token, without a manual reconnect.
 *
 * Endpoint (confirmed via network capture on web.plaud.ai):
 *   POST {apiBase}/user-app/auth/workspace/refresh/{workspaceId}
 *   Authorization: Bearer <refresh_token>   (JWT typ "WRT")
 *   body: {}
 * The response carries a fresh access_token AND a fresh refresh_token
 * (rotation), so both are re-persisted on every refresh.
 */

const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36";

export interface RefreshedTokens {
    accessToken: string;
    refreshToken: string;
}

/** A function that refreshes the access token for the current region base. */
export type TokenRefresher = (apiBase: string) => Promise<string>;

/**
 * Decode the `wid` (workspace id) claim from a Plaud JWT without verifying the
 * signature — we only need the identifier for the refresh URL. Tolerates a
 * leading "Bearer " prefix.
 */
export function decodeWorkspaceId(token: string): string | null {
    const jwt = token.replace(/^Bearer\s+/i, "");
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    try {
        const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
        ) as { wid?: unknown };
        return typeof payload.wid === "string" ? payload.wid : null;
    } catch {
        return null;
    }
}

/** Pull the first present string value for any of `keys`, top-level or under `data`. */
function pickString(
    obj: Record<string, unknown>,
    keys: string[],
): string | null {
    const nested =
        typeof obj.data === "object" && obj.data !== null
            ? (obj.data as Record<string, unknown>)
            : {};
    for (const key of keys) {
        const v = obj[key] ?? nested[key];
        if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
}

/**
 * Call the Plaud refresh endpoint. Throws (never returns partial tokens) so the
 * caller can fall back to surfacing the original -419 via the reconnect banner.
 */
export async function refreshWorkspaceToken(
    apiBase: string,
    refreshToken: string,
): Promise<RefreshedTokens> {
    const workspaceId = decodeWorkspaceId(refreshToken);
    if (!workspaceId) {
        throw new Error("Cannot refresh Plaud token: no `wid` claim in token");
    }

    const response = await fetch(
        `${apiBase}/user-app/auth/workspace/refresh/${workspaceId}`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${refreshToken.replace(/^Bearer\s+/i, "")}`,
                "Content-Type": "application/json",
                "User-Agent": BROWSER_USER_AGENT,
            },
            body: "{}",
        },
    );

    if (!response.ok) {
        throw new Error(`Plaud token refresh failed (HTTP ${response.status})`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Plaud signals app-level failure with a non-zero `status` (outer envelope
    // and/or the nested `data`) even on HTTP 200. Treat that as a failed
    // refresh so the caller falls back to the -419/reconnect-banner flow
    // instead of mistaking an error body for a fresh token.
    const nestedData =
        typeof data.data === "object" && data.data !== null
            ? (data.data as Record<string, unknown>)
            : {};
    const outerStatus = typeof data.status === "number" ? data.status : null;
    const innerStatus =
        typeof nestedData.status === "number" ? nestedData.status : null;
    if (
        (outerStatus !== null && outerStatus !== 0) ||
        (innerStatus !== null && innerStatus !== 0)
    ) {
        throw new Error(
            `Plaud token refresh returned status ${outerStatus ?? innerStatus}`,
        );
    }

    const accessToken = pickString(data, [
        "access_token",
        "accessToken",
        "workspace_token",
        "workspaceToken",
        "token",
    ]);
    if (!accessToken) {
        throw new Error("Plaud token refresh returned no access token");
    }
    // Refresh tokens rotate; if the response omits a new one, keep the old.
    const rotatedRefresh =
        pickString(data, ["refresh_token", "refreshToken"]) ?? refreshToken;

    return { accessToken, refreshToken: rotatedRefresh };
}

/**
 * Build a refresher bound to a single connection row. Each call rotates the
 * token, persists the new (encrypted) access + refresh tokens, and returns the
 * new access token for the in-flight client to retry with.
 */
export function createTokenRefresher(
    connectionId: string,
    encryptedRefreshToken: string,
): TokenRefresher {
    let currentRefreshToken = decrypt(encryptedRefreshToken);

    return async (apiBase: string): Promise<string> => {
        const rotated = await refreshWorkspaceToken(
            apiBase,
            currentRefreshToken,
        );
        currentRefreshToken = rotated.refreshToken;

        await db
            .update(plaudConnections)
            .set({
                bearerToken: encrypt(rotated.accessToken),
                refreshToken: encrypt(rotated.refreshToken),
                updatedAt: new Date(),
            })
            .where(eq(plaudConnections.id, connectionId));

        return rotated.accessToken;
    };
}
