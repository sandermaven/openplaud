import { describe, expect, it } from "vitest";
import {
    COPY_BEARER_COMMAND,
    COPY_REFRESH_COMMAND,
    COPY_SESSION_COMMAND,
} from "../lib/plaud/connect-commands";
import {
    apiBaseForToken,
    decodeTokenClaims,
    describeTokens,
    parseSessionTokens,
    parseTimestamp,
    serverKeyForRegion,
    stripBearerPrefix,
    tokenExpiry,
} from "../lib/plaud/token-info";

/** A structurally valid JWT with made-up claims and no real signature. */
function fakeJwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

const ACCESS_EXP = 1_800_000_000;
const REFRESH_EXP = ACCESS_EXP + 27 * 24 * 3600;

const ACCESS = fakeJwt({
    exp: ACCESS_EXP,
    iat: ACCESS_EXP - 86_400,
    wid: "ws_test",
    region: "aws:eu-central-1",
});
const REFRESH = fakeJwt({
    exp: REFRESH_EXP,
    wid: "ws_test",
    region: "aws:eu-central-1",
    typ: "WRT",
});

function sessionJson(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        epoch: "1",
        byWsId: {
            ws_test: {
                token: ACCESS,
                tokenType: "Bearer",
                expiresAt: ACCESS_EXP * 1000,
                refreshToken: REFRESH,
                refreshExpiresAt: REFRESH_EXP * 1000,
                ...extra,
            },
        },
    });
}

describe("Console commands", () => {
    const commands = [
        COPY_SESSION_COMMAND,
        COPY_BEARER_COMMAND,
        COPY_REFRESH_COMMAND,
    ];

    it("contain only straight quotes", () => {
        for (const command of commands) {
            expect(command).not.toMatch(/[‘’“”«»]/);
            expect(command).toContain('"pld_session.tokens"');
        }
    });

    it("are plain ASCII on a single line", () => {
        for (const command of commands) {
            expect(command).toMatch(/^[\x20-\x7E]+$/);
        }
    });

    it("match the commands that work in the Plaud web app", () => {
        expect(COPY_SESSION_COMMAND).toBe(
            'copy(localStorage.getItem("pld_session.tokens"))',
        );
        expect(COPY_BEARER_COMMAND).toBe(
            'copy("Bearer " + Object.values(JSON.parse(localStorage.getItem("pld_session.tokens")).byWsId)[0].token)',
        );
        expect(COPY_REFRESH_COMMAND).toBe(
            'copy(Object.values(JSON.parse(localStorage.getItem("pld_session.tokens")).byWsId)[0].refreshToken)',
        );
    });
});

describe("token claims", () => {
    it("decodes claims with or without a Bearer prefix", () => {
        expect(decodeTokenClaims(ACCESS)?.wid).toBe("ws_test");
        expect(decodeTokenClaims(`Bearer ${ACCESS}`)?.region).toBe(
            "aws:eu-central-1",
        );
    });

    it("returns null for something that is not a JWT", () => {
        expect(decodeTokenClaims("not-a-token")).toBeNull();
        expect(decodeTokenClaims("a.b.c")).toBeNull();
        expect(tokenExpiry("not-a-token")).toBeNull();
    });

    it("reads the expiry from exp", () => {
        expect(tokenExpiry(ACCESS)?.getTime()).toBe(ACCESS_EXP * 1000);
    });

    it("strips the prefix, whitespace and stray quotes", () => {
        expect(stripBearerPrefix(`  Bearer ${ACCESS}\n`)).toBe(ACCESS);
        expect(stripBearerPrefix(`"bearer ${ACCESS}"`)).toBe(ACCESS);
        expect(stripBearerPrefix(ACCESS)).toBe(ACCESS);
    });
});

describe("region to server", () => {
    it("maps eu-central-1 to the Frankfurt server", () => {
        expect(serverKeyForRegion("aws:eu-central-1")).toBe("eu");
        expect(apiBaseForToken(ACCESS)).toBe("https://api-euc1.plaud.ai");
    });

    it("returns null for an unknown or missing region", () => {
        expect(serverKeyForRegion("aws:mars-north-1")).toBeNull();
        expect(serverKeyForRegion(undefined)).toBeNull();
        expect(apiBaseForToken(fakeJwt({ exp: ACCESS_EXP }))).toBeNull();
    });
});

describe("parseTimestamp", () => {
    it("accepts seconds, milliseconds, numeric strings and ISO strings", () => {
        const ms = ACCESS_EXP * 1000;
        expect(parseTimestamp(ACCESS_EXP)?.getTime()).toBe(ms);
        expect(parseTimestamp(ms)?.getTime()).toBe(ms);
        expect(parseTimestamp(String(ms))?.getTime()).toBe(ms);
        expect(parseTimestamp(new Date(ms).toISOString())?.getTime()).toBe(ms);
    });

    it("returns null for junk", () => {
        expect(parseTimestamp(null)).toBeNull();
        expect(parseTimestamp("soon")).toBeNull();
        expect(parseTimestamp(0)).toBeNull();
    });
});

describe("parseSessionTokens", () => {
    it("extracts both tokens, expiries, workspace and server", () => {
        const parsed = parseSessionTokens(sessionJson());
        expect(parsed).not.toBeNull();
        expect(parsed?.bearerToken).toBe(ACCESS);
        expect(parsed?.refreshToken).toBe(REFRESH);
        expect(parsed?.accessExpiresAt?.getTime()).toBe(ACCESS_EXP * 1000);
        expect(parsed?.refreshExpiresAt?.getTime()).toBe(REFRESH_EXP * 1000);
        expect(parsed?.workspaceId).toBe("ws_test");
        expect(parsed?.region).toBe("aws:eu-central-1");
        expect(parsed?.serverKey).toBe("eu");
        expect(parsed?.workspaceCount).toBe(1);
    });

    it("falls back to the stored expiry when a token is not a JWT", () => {
        const parsed = parseSessionTokens(
            sessionJson({ token: "opaque-access", refreshToken: "opaque-rt" }),
        );
        expect(parsed?.accessExpiresAt?.getTime()).toBe(ACCESS_EXP * 1000);
        expect(parsed?.refreshExpiresAt?.getTime()).toBe(REFRESH_EXP * 1000);
        expect(parsed?.serverKey).toBeNull();
    });

    it("accepts a session without a refresh token", () => {
        const parsed = parseSessionTokens(
            sessionJson({ refreshToken: undefined }),
        );
        expect(parsed?.refreshToken).toBeNull();
        expect(parsed?.refreshExpiresAt).toBeNull();
    });

    it("accepts a value that was JSON-encoded twice", () => {
        const parsed = parseSessionTokens(JSON.stringify(sessionJson()));
        expect(parsed?.bearerToken).toBe(ACCESS);
    });

    it("counts multiple workspaces and uses the first", () => {
        const raw = JSON.parse(sessionJson());
        raw.byWsId.ws_other = { token: fakeJwt({ exp: 1, wid: "ws_other" }) };
        const parsed = parseSessionTokens(JSON.stringify(raw));
        expect(parsed?.workspaceId).toBe("ws_test");
        expect(parsed?.workspaceCount).toBe(2);
    });

    it("rejects anything that is not the session structure", () => {
        expect(parseSessionTokens("")).toBeNull();
        expect(parseSessionTokens("undefined")).toBeNull();
        expect(parseSessionTokens(ACCESS)).toBeNull();
        expect(parseSessionTokens('{"byWsId": {}}')).toBeNull();
        expect(parseSessionTokens('{"epoch": "1"}')).toBeNull();
        // Curly quotes, as pasted through a word processor.
        expect(parseSessionTokens("{“epoch”: “1”}")).toBeNull();
    });
});

describe("describeTokens", () => {
    it("handles the separate fields, with the Bearer prefix", () => {
        const parsed = describeTokens(`Bearer ${ACCESS}`, REFRESH);
        expect(parsed?.bearerToken).toBe(ACCESS);
        expect(parsed?.refreshToken).toBe(REFRESH);
        expect(parsed?.serverKey).toBe("eu");
    });

    it("returns null without a bearer token", () => {
        expect(describeTokens("   ")).toBeNull();
    });

    it("treats an empty refresh token as absent", () => {
        expect(describeTokens(ACCESS, "  ")?.refreshToken).toBeNull();
    });
});
