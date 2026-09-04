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
// Mock both so the pure HTTP parsing can be tested without a DB/env.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/encryption", () => ({
    encrypt: (s: string) => s,
    decrypt: (s: string) => s,
}));

import { refreshWorkspaceToken } from "../lib/plaud/refresh";

// A JWT whose payload carries the wid claim the refresh URL needs.
const widPayload = Buffer.from(JSON.stringify({ wid: "ws_test" })).toString(
    "base64url",
);
const REFRESH_JWT = `header.${widPayload}.sig`;

const originalFetch = global.fetch;
let mockFetch: Mock;

beforeAll(() => {
    mockFetch = vi.fn() as Mock;
    global.fetch = mockFetch as typeof global.fetch;
});
afterAll(() => {
    global.fetch = originalFetch;
});
beforeEach(() => vi.clearAllMocks());

describe("refreshWorkspaceToken parsing", () => {
    it("parses workspace_token + refresh_token from the real live envelope", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () =>
                Promise.resolve({
                    status: 0,
                    data: {
                        status: 0,
                        workspace_token: "NEW_ACCESS",
                        expires_in: 86400,
                        wt_expires_at: 1788615392,
                        refresh_token: "NEW_REFRESH",
                        refresh_expires_at: 1790778416,
                        version_tag: "v3",
                    },
                    trace_id: "x",
                }),
        });

        const res = await refreshWorkspaceToken(
            "https://api-euc1.plaud.ai",
            REFRESH_JWT,
        );

        expect(res.accessToken).toBe("NEW_ACCESS");
        expect(res.refreshToken).toBe("NEW_REFRESH");
    });

    it("throws on a non-zero status so the caller falls back to the -419 flow", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () =>
                Promise.resolve({
                    status: -419,
                    data: { status: -419 },
                    msg: "workspace token expired",
                }),
        });

        await expect(
            refreshWorkspaceToken("https://api-euc1.plaud.ai", REFRESH_JWT),
        ).rejects.toThrow("status -419");
    });

    it("throws when the token is missing from an otherwise-ok body", async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ status: 0, data: { status: 0 } }),
        });

        await expect(
            refreshWorkspaceToken("https://api-euc1.plaud.ai", REFRESH_JWT),
        ).rejects.toThrow("no access token");
    });
});
