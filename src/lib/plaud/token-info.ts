import { PLAUD_SERVERS, type PlaudServerKey } from "./servers";

/**
 * Reading what a Plaud token says about itself.
 *
 * Everything here decodes without verifying the signature: we only use the
 * claims to pick a server and to know when to refresh, never to trust anyone.
 * The module is pure and has no Node-only imports, so the connect screen can
 * run the same parsing in the browser that the connect route runs on the
 * server.
 */

export interface PlaudTokenClaims {
    /** Expiry, seconds since epoch. */
    exp?: number;
    iat?: number;
    /** Workspace id, e.g. `ws_...`. */
    wid?: string;
    /** Cloud region the account lives in, e.g. `aws:eu-central-1`. */
    region?: string;
    /** Browser session the token belongs to. */
    ut_sid?: string;
}

/** Drop a leading `Bearer ` and surrounding whitespace or quotes. */
export function stripBearerPrefix(token: string): string {
    return token
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/^Bearer\s+/i, "")
        .trim();
}

function base64UrlDecode(input: string): string {
    const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/** Decode a JWT payload without verifying it. Null when it is not a JWT. */
export function decodeTokenClaims(token: string): PlaudTokenClaims | null {
    const parts = stripBearerPrefix(token).split(".");
    if (parts.length < 2) return null;
    try {
        const payload = JSON.parse(base64UrlDecode(parts[1])) as unknown;
        if (typeof payload !== "object" || payload === null) return null;
        return payload as PlaudTokenClaims;
    } catch {
        return null;
    }
}

/** When the token expires according to its own `exp` claim. */
export function tokenExpiry(token: string): Date | null {
    const exp = decodeTokenClaims(token)?.exp;
    return typeof exp === "number" && Number.isFinite(exp)
        ? new Date(exp * 1000)
        : null;
}

/**
 * Region claim to API server. Only regions whose host has been confirmed are
 * listed; anything else falls back to the manual choice plus the -302
 * redirect the client already follows.
 */
const REGION_SERVERS: Record<string, PlaudServerKey> = {
    "aws:eu-central-1": "eu",
};

export function serverKeyForRegion(
    region: string | undefined | null,
): PlaudServerKey | null {
    if (!region) return null;
    return REGION_SERVERS[region.toLowerCase()] ?? null;
}

/** The server a token belongs on, read from its `region` claim. */
export function serverKeyForToken(token: string): PlaudServerKey | null {
    return serverKeyForRegion(decodeTokenClaims(token)?.region);
}

/** The API base a token belongs on, or null when the region is unknown. */
export function apiBaseForToken(token: string): string | null {
    const key = serverKeyForToken(token);
    return key ? PLAUD_SERVERS[key].apiBase : null;
}

/**
 * Timestamps in the web app's session store are not documented. Accept
 * seconds, milliseconds, numeric strings and ISO strings.
 */
export function parseTimestamp(value: unknown): Date | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return new Date(value < 1e11 ? value * 1000 : value);
    }
    if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return parseTimestamp(numeric);
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : new Date(parsed);
    }
    return null;
}

export interface ParsedPlaudCredentials {
    /** Access token without the `Bearer ` prefix. */
    bearerToken: string;
    refreshToken: string | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
    workspaceId: string | null;
    region: string | null;
    serverKey: PlaudServerKey | null;
    /** How many workspaces the pasted session held; the first one is used. */
    workspaceCount: number;
}

function describe(
    bearerToken: string,
    refreshToken: string | null,
    stored: { expiresAt?: unknown; refreshExpiresAt?: unknown } = {},
    workspaceId: string | null = null,
    workspaceCount = 1,
): ParsedPlaudCredentials {
    const claims = decodeTokenClaims(bearerToken);
    const region = claims?.region ?? null;
    return {
        bearerToken,
        refreshToken,
        // The token's own `exp` is what Plaud enforces; the stored value is
        // only a fallback for a token we cannot decode.
        accessExpiresAt:
            tokenExpiry(bearerToken) ?? parseTimestamp(stored.expiresAt),
        refreshExpiresAt: refreshToken
            ? (tokenExpiry(refreshToken) ??
              parseTimestamp(stored.refreshExpiresAt))
            : null,
        workspaceId: workspaceId ?? claims?.wid ?? null,
        region,
        serverKey: serverKeyForRegion(region),
        workspaceCount,
    };
}

/** Describe tokens entered in the separate fields. */
export function describeTokens(
    bearerToken: string,
    refreshToken?: string | null,
): ParsedPlaudCredentials | null {
    const bearer = stripBearerPrefix(bearerToken);
    if (!bearer) return null;
    const refresh = refreshToken ? stripBearerPrefix(refreshToken) : "";
    return describe(bearer, refresh || null);
}

/**
 * Parse the value of `localStorage["pld_session.tokens"]` on web.plaud.ai:
 *
 *   {"epoch": "...", "byWsId": {"ws_...": {"token", "tokenType", "expiresAt",
 *                                          "refreshToken", "refreshExpiresAt"}}}
 *
 * Returns null when the text is not that structure, so the caller can tell
 * the user instead of sending half a credential to Plaud.
 */
export function parseSessionTokens(raw: string): ParsedPlaudCredentials | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.trim());
        // `copy()` of a string can arrive JSON-encoded a second time.
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;

    const byWsId = (parsed as { byWsId?: unknown }).byWsId;
    if (typeof byWsId !== "object" || byWsId === null) return null;

    const entries = Object.entries(byWsId as Record<string, unknown>).filter(
        (entry): entry is [string, Record<string, unknown>] =>
            typeof entry[1] === "object" &&
            entry[1] !== null &&
            typeof (entry[1] as { token?: unknown }).token === "string",
    );
    if (entries.length === 0) return null;

    const [workspaceId, entry] = entries[0];
    const bearer = stripBearerPrefix(entry.token as string);
    if (!bearer) return null;
    const refresh =
        typeof entry.refreshToken === "string"
            ? stripBearerPrefix(entry.refreshToken)
            : "";

    return describe(
        bearer,
        refresh || null,
        entry,
        workspaceId,
        entries.length,
    );
}
