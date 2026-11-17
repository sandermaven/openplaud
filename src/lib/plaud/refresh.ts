import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import {
    apiBaseForToken,
    decodeTokenClaims,
    stripBearerPrefix,
    tokenExpiry,
} from "./token-info";

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
 *
 * Two things this module guarantees on top of the HTTP call:
 *
 * - Refreshing is proactive. The access token lives 24 hours; waiting for the
 *   -419 means every caller that happens to be running at that moment (cron
 *   sync, the dashboard's auto-sync, the audio proxy, a transcription) finds
 *   out at once and each spends the same refresh token.
 * - Refreshing is serialised per connection. Because the refresh token
 *   rotates, a second refresh with the token the first one just used up is
 *   rejected, and whichever caller writes last could store a pair Plaud no
 *   longer honours. The row lock makes the losers reuse the winner's result.
 */

const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36";

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000;

/** After Plaud rejects a refresh, wait this long before asking again. */
export const REFRESH_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

const REFRESH_TIMEOUT_MS = 20_000;

export interface RefreshedTokens {
    accessToken: string;
    refreshToken: string;
}

/**
 * A function that refreshes the access token. `staleToken` is the token the
 * caller just saw rejected, so a refresh another caller already completed can
 * be reused instead of repeated.
 */
export type TokenRefresher = (
    apiBase: string,
    staleToken?: string,
) => Promise<string>;

/**
 * Plaud answered the refresh call and said no (HTTP 4xx or a non-zero app
 * status such as -420). Retrying will not help; only a reconnect does. A
 * timeout or a 5xx is a plain Error and gets retried on the next run.
 */
export class PlaudRefreshRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PlaudRefreshRejectedError";
    }
}

/**
 * Decode the `wid` (workspace id) claim from a Plaud JWT without verifying the
 * signature — we only need the identifier for the refresh URL. Tolerates a
 * leading "Bearer " prefix.
 */
export function decodeWorkspaceId(token: string): string | null {
    const wid = decodeTokenClaims(token)?.wid;
    return typeof wid === "string" ? wid : null;
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
 *
 * The server is taken from the refresh token's own `region` claim when we
 * know that region, and from `apiBase` otherwise; a -302 "wrong region"
 * answer is followed once, the same way data calls do.
 */
export async function refreshWorkspaceToken(
    apiBase: string,
    refreshToken: string,
    regionRedirected = false,
): Promise<RefreshedTokens> {
    const token = stripBearerPrefix(refreshToken);
    const workspaceId = decodeWorkspaceId(token);
    if (!workspaceId) {
        throw new PlaudRefreshRejectedError(
            "Cannot refresh Plaud token: no `wid` claim in token",
        );
    }

    const base = regionRedirected
        ? apiBase
        : (apiBaseForToken(token) ?? apiBase);

    const response = await fetch(
        `${base}/user-app/auth/workspace/refresh/${workspaceId}`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": BROWSER_USER_AGENT,
            },
            body: "{}",
            signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        },
    );

    if (!response.ok) {
        const message = `Plaud token refresh failed (HTTP ${response.status})`;
        // 4xx is Plaud turning the token down; 5xx/429 is Plaud having a
        // bad moment and says nothing about the token.
        if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
        ) {
            throw new PlaudRefreshRejectedError(message);
        }
        throw new Error(message);
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

    if (outerStatus === -302 && !regionRedirected) {
        const domains = nestedData.domains as { api?: unknown } | undefined;
        if (typeof domains?.api === "string" && domains.api !== base) {
            return refreshWorkspaceToken(domains.api, token, true);
        }
    }

    if (
        (outerStatus !== null && outerStatus !== 0) ||
        (innerStatus !== null && innerStatus !== 0)
    ) {
        throw new PlaudRefreshRejectedError(
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
        pickString(data, ["refresh_token", "refreshToken"]) ?? token;

    return {
        accessToken: stripBearerPrefix(accessToken),
        refreshToken: stripBearerPrefix(rotatedRefresh),
    };
}

type ConnectionRow = typeof plaudConnections.$inferSelect;

/** When the stored access token expires, as far as we can tell. */
export function accessExpiryOf(
    connection: Pick<ConnectionRow, "accessExpiresAt" | "bearerToken">,
): Date | null {
    if (connection.accessExpiresAt) return connection.accessExpiresAt;
    try {
        return tokenExpiry(decrypt(connection.bearerToken));
    } catch {
        return null;
    }
}

/**
 * Whether the access token should be rotated now, ahead of its expiry.
 *
 * False without a refresh token (nothing to rotate with), without a known
 * expiry (the reactive -419 path still covers that), and shortly after Plaud
 * rejected a refresh, so a dead refresh token is not hammered every run.
 */
export function needsProactiveRefresh(
    connection: Pick<
        ConnectionRow,
        | "accessExpiresAt"
        | "bearerToken"
        | "refreshToken"
        | "refreshError"
        | "refreshErrorAt"
    >,
    now: Date = new Date(),
): boolean {
    if (!connection.refreshToken) return false;
    const expiry = accessExpiryOf(connection);
    if (!expiry) return false;
    if (expiry.getTime() - now.getTime() > REFRESH_MARGIN_MS) return false;
    if (
        connection.refreshError &&
        connection.refreshErrorAt &&
        now.getTime() - connection.refreshErrorAt.getTime() <
            REFRESH_RETRY_COOLDOWN_MS
    ) {
        return false;
    }
    return true;
}

export type RefreshReason = "proactive" | "expired";

/** One line per refresh attempt: outcome and times, never token material. */
function logRefresh(
    connectionId: string,
    reason: RefreshReason,
    outcome: string,
    extra: Record<string, string | null> = {},
): void {
    const fields = Object.entries(extra)
        .map(([k, v]) => `${k}=${v ?? "unknown"}`)
        .join(" ");
    console.log(
        `[plaud-refresh] connection=${connectionId} reason=${reason} outcome=${outcome} ${fields}`.trim(),
    );
}

/**
 * Rotate the tokens of one connection and persist the result.
 *
 * Runs under a row lock. A caller that arrives while another refresh is in
 * flight waits, then finds a token that differs from the one it saw rejected
 * (or one that no longer needs refreshing) and returns that instead of
 * spending the refresh token a second time.
 *
 * Returns the access token to use. Throws when the refresh failed; the
 * failure is recorded on the row and, when Plaud rejected the token, the
 * user is mailed (at most once a day).
 */
export async function refreshConnection(
    connectionId: string,
    options: {
        reason: RefreshReason;
        apiBase?: string;
        staleToken?: string;
    },
): Promise<string> {
    const { reason } = options;
    try {
        return await db.transaction(async (tx) => {
            const [row] = await tx
                .select()
                .from(plaudConnections)
                .where(eq(plaudConnections.id, connectionId))
                .for("update");
            if (!row) throw new Error("Plaud connection not found");

            const current = stripBearerPrefix(decrypt(row.bearerToken));
            if (
                options.staleToken &&
                current !== stripBearerPrefix(options.staleToken)
            ) {
                logRefresh(connectionId, reason, "reused");
                return current;
            }
            if (reason === "proactive" && !needsProactiveRefresh(row)) {
                return current;
            }
            if (!row.refreshToken) {
                throw new PlaudRefreshRejectedError(
                    "Cannot refresh Plaud token: no refresh token stored",
                );
            }

            const rotated = await refreshWorkspaceToken(
                options.apiBase ?? row.apiBase,
                decrypt(row.refreshToken),
            );
            const accessExpiresAt = tokenExpiry(rotated.accessToken);
            const refreshExpiresAt = tokenExpiry(rotated.refreshToken);
            const now = new Date();

            await tx
                .update(plaudConnections)
                .set({
                    bearerToken: encrypt(rotated.accessToken),
                    refreshToken: encrypt(rotated.refreshToken),
                    accessExpiresAt,
                    // Keep the known date if the new token is not decodable.
                    ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
                    lastRefreshAt: now,
                    refreshError: null,
                    refreshErrorAt: null,
                    updatedAt: now,
                })
                .where(eq(plaudConnections.id, connectionId));

            logRefresh(connectionId, reason, "ok", {
                accessExpiresAt: accessExpiresAt?.toISOString() ?? null,
                refreshExpiresAt: refreshExpiresAt?.toISOString() ?? null,
            });
            return rotated.accessToken;
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rejected = error instanceof PlaudRefreshRejectedError;
        logRefresh(connectionId, reason, rejected ? "rejected" : "error", {
            detail: JSON.stringify(message),
        });

        // Outside the transaction: the rollback above would undo it.
        await db
            .update(plaudConnections)
            .set({ refreshError: message, refreshErrorAt: new Date() })
            .where(eq(plaudConnections.id, connectionId))
            .catch(() => {});

        if (rejected) {
            const { alertConnectionProblem } = await import(
                "./connection-alerts"
            );
            await alertConnectionProblem(
                connectionId,
                "refresh-rejected",
            ).catch((alertError) =>
                console.error("[plaud-refresh] alert failed:", alertError),
            );
        }
        throw error;
    }
}

/**
 * Rotate the access token if it is close to expiring. Never throws: a failed
 * proactive refresh leaves a token that is still valid for a while, so the
 * caller carries on and the failure is reported through the row and the mail.
 * Returns true when the row may have changed and should be re-read.
 */
export async function refreshIfDue(
    connection: Pick<
        ConnectionRow,
        | "id"
        | "accessExpiresAt"
        | "bearerToken"
        | "refreshToken"
        | "refreshError"
        | "refreshErrorAt"
    >,
): Promise<boolean> {
    if (!needsProactiveRefresh(connection)) return false;
    try {
        await refreshConnection(connection.id, { reason: "proactive" });
    } catch {
        // Recorded and reported inside refreshConnection.
    }
    return true;
}

/**
 * Build a refresher bound to a single connection row, for the reactive path:
 * the client calls it when Plaud says the access token expired. Parallel
 * requests on one client share a single refresh.
 */
export function createTokenRefresher(connectionId: string): TokenRefresher {
    let inFlight: Promise<string> | null = null;

    return (apiBase: string, staleToken?: string): Promise<string> => {
        if (!inFlight) {
            inFlight = refreshConnection(connectionId, {
                reason: "expired",
                apiBase,
                staleToken,
            }).finally(() => {
                inFlight = null;
            });
        }
        return inFlight;
    };
}
