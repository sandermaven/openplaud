import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

// refresh.ts imports @/db (which validates env at load) and @/lib/encryption.
vi.mock("@/db", () => ({ db: {} }));
// connection-alerts.ts pulls in the env validation and the mailer.
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/encryption", () => ({
    encrypt: (s: string) => s,
    decrypt: (s: string) => s,
}));

import { PlaudClient } from "../lib/plaud/client";
import { buildAlertMessage } from "../lib/plaud/connection-alerts";
import {
    needsProactiveRefresh,
    PlaudRefreshRejectedError,
    REFRESH_MARGIN_MS,
    REFRESH_RETRY_COOLDOWN_MS,
    refreshWorkspaceToken,
} from "../lib/plaud/refresh";

function fakeJwt(claims: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

const NOW = new Date("2026-11-13T12:00:00Z");

function connection(overrides: Record<string, unknown> = {}) {
    return {
        bearerToken: "opaque-access",
        refreshToken: "opaque-refresh" as string | null,
        accessExpiresAt: new Date(
            NOW.getTime() + 60 * 60 * 1000,
        ) as Date | null,
        refreshError: null as string | null,
        refreshErrorAt: null as Date | null,
        ...overrides,
    };
}

describe("needsProactiveRefresh", () => {
    it("is true inside the margin before expiry", () => {
        expect(needsProactiveRefresh(connection(), NOW)).toBe(true);
    });

    it("is true once the token has already expired", () => {
        const expired = new Date(NOW.getTime() - 1000);
        expect(
            needsProactiveRefresh(
                connection({ accessExpiresAt: expired }),
                NOW,
            ),
        ).toBe(true);
    });

    it("is false while the token has more than the margin left", () => {
        const later = new Date(NOW.getTime() + REFRESH_MARGIN_MS + 60_000);
        expect(
            needsProactiveRefresh(connection({ accessExpiresAt: later }), NOW),
        ).toBe(false);
    });

    it("is false without a refresh token", () => {
        expect(
            needsProactiveRefresh(connection({ refreshToken: null }), NOW),
        ).toBe(false);
    });

    it("reads the expiry from the token when the column is empty", () => {
        const soon = Math.floor(NOW.getTime() / 1000) + 600;
        expect(
            needsProactiveRefresh(
                connection({
                    accessExpiresAt: null,
                    bearerToken: fakeJwt({ exp: soon }),
                }),
                NOW,
            ),
        ).toBe(true);
    });

    it("is false when the expiry is unknown", () => {
        expect(
            needsProactiveRefresh(connection({ accessExpiresAt: null }), NOW),
        ).toBe(false);
    });

    it("backs off after a failed refresh, then tries again", () => {
        const justFailed = connection({
            refreshError: "Plaud token refresh returned status -420",
            refreshErrorAt: new Date(NOW.getTime() - 60_000),
        });
        expect(needsProactiveRefresh(justFailed, NOW)).toBe(false);

        const failedLongAgo = connection({
            refreshError: "Plaud token refresh returned status -420",
            refreshErrorAt: new Date(
                NOW.getTime() - REFRESH_RETRY_COOLDOWN_MS - 1000,
            ),
        });
        expect(needsProactiveRefresh(failedLongAgo, NOW)).toBe(true);
    });
});

const originalFetch = global.fetch;
let mockFetch: Mock;

beforeAll(() => {
    mockFetch = vi.fn() as Mock;
    global.fetch = mockFetch as typeof global.fetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

beforeEach(() => {
    vi.clearAllMocks();
});

function json(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: () => Promise.resolve(body),
    };
}

describe("refreshWorkspaceToken", () => {
    const EU_REFRESH = fakeJwt({ wid: "ws_test", region: "aws:eu-central-1" });
    const NO_REGION_REFRESH = fakeJwt({ wid: "ws_test" });

    it("calls the server from the token's region, not the stored one", async () => {
        mockFetch.mockResolvedValueOnce(
            json({ status: 0, data: { workspace_token: "new-access" } }),
        );

        await refreshWorkspaceToken("https://api.plaud.ai", EU_REFRESH);

        expect(mockFetch.mock.calls[0][0]).toBe(
            "https://api-euc1.plaud.ai/user-app/auth/workspace/refresh/ws_test",
        );
    });

    it("uses the stored server when the token names no known region", async () => {
        mockFetch.mockResolvedValueOnce(
            json({ status: 0, data: { workspace_token: "new-access" } }),
        );

        await refreshWorkspaceToken("https://api.plaud.ai", NO_REGION_REFRESH);

        expect(mockFetch.mock.calls[0][0]).toBe(
            "https://api.plaud.ai/user-app/auth/workspace/refresh/ws_test",
        );
    });

    it("follows a -302 region redirect once", async () => {
        mockFetch
            .mockResolvedValueOnce(
                json({
                    status: -302,
                    data: { domains: { api: "https://api-euc1.plaud.ai" } },
                }),
            )
            .mockResolvedValueOnce(
                json({
                    status: 0,
                    data: {
                        workspace_token: "new-access",
                        refresh_token: "new-refresh",
                    },
                }),
            );

        const result = await refreshWorkspaceToken(
            "https://api.plaud.ai",
            NO_REGION_REFRESH,
        );

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][0]).toBe(
            "https://api-euc1.plaud.ai/user-app/auth/workspace/refresh/ws_test",
        );
        expect(result).toEqual({
            accessToken: "new-access",
            refreshToken: "new-refresh",
        });
    });

    it("marks an app-level rejection (-420) as rejected", async () => {
        mockFetch.mockResolvedValueOnce(json({ status: -420, msg: "nope" }));
        await expect(
            refreshWorkspaceToken("https://api.plaud.ai", EU_REFRESH),
        ).rejects.toBeInstanceOf(PlaudRefreshRejectedError);
    });

    it("marks an HTTP 401 as rejected", async () => {
        mockFetch.mockResolvedValueOnce(json({}, 401));
        await expect(
            refreshWorkspaceToken("https://api.plaud.ai", EU_REFRESH),
        ).rejects.toBeInstanceOf(PlaudRefreshRejectedError);
    });

    it("treats a 5xx as transient, not as a rejection", async () => {
        mockFetch.mockResolvedValueOnce(json({}, 503));
        const error = await refreshWorkspaceToken(
            "https://api.plaud.ai",
            EU_REFRESH,
        ).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(PlaudRefreshRejectedError);
    });

    it("never puts the token in an error message", async () => {
        mockFetch.mockResolvedValueOnce(json({ status: -420 }));
        const error = await refreshWorkspaceToken(
            "https://api.plaud.ai",
            EU_REFRESH,
        ).catch((e) => e);
        expect(String(error.message)).not.toContain(EU_REFRESH);
    });
});

describe("PlaudClient on HTTP 401", () => {
    it("refreshes and retries once", async () => {
        const refresher = vi.fn().mockResolvedValue("fresh-token");
        const client = new PlaudClient(
            "Bearer stale-token",
            "https://api-euc1.plaud.ai",
            refresher,
        );
        mockFetch
            .mockResolvedValueOnce(json({ msg: "unauthorized" }, 401))
            .mockResolvedValueOnce(json({ status: 0, data_devices: [] }));

        await client.listDevices();

        // The prefix the user pasted is not sent twice, and the refresher
        // learns which token went stale.
        expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(
            "Bearer stale-token",
        );
        expect(refresher).toHaveBeenCalledWith(
            "https://api-euc1.plaud.ai",
            "stale-token",
        );
        expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe(
            "Bearer fresh-token",
        );
    });

    it("surfaces the 401 when the refresh fails", async () => {
        const refresher = vi.fn().mockRejectedValue(new Error("rejected"));
        const client = new PlaudClient(
            "stale",
            "https://api.plaud.ai",
            refresher,
        );
        mockFetch.mockResolvedValueOnce(json({ msg: "unauthorized" }, 401));

        await expect(client.listDevices()).rejects.toThrow("401");
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe("buildAlertMessage", () => {
    const url = "https://openplaud.example/onboarding?reconnect=1";

    it("links straight to the connect screen", () => {
        const message = buildAlertMessage("expired", url, null, NOW);
        expect(message.text).toContain(url);
        expect(message.html).toContain(`href="${url}"`);
        expect(message.subject).toBe("Je Plaud-koppeling is verlopen");
    });

    it("says how long the token still works after a rejected refresh", () => {
        const until = new Date(NOW.getTime() + 60 * 60 * 1000);
        const message = buildAlertMessage("refresh-rejected", url, until, NOW);
        expect(message.subject).toContain("vernieuwen is mislukt");
        expect(message.text).toContain("werkt nog tot");
    });

    it("reports a rejected refresh on a dead token as expired", () => {
        const past = new Date(NOW.getTime() - 1000);
        const message = buildAlertMessage("refresh-rejected", url, past, NOW);
        expect(message.subject).toBe("Je Plaud-koppeling is verlopen");
    });
});
