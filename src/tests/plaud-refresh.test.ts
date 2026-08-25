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
import { DEFAULT_PLAUD_API_BASE, PlaudClient } from "../lib/plaud/client";

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

/** Plaud signals an expired workspace token with HTTP 200 + body status -419. */
function tokenExpiredResponse() {
    return {
        ok: true,
        json: () =>
            Promise.resolve({
                status: -419,
                msg: "workspace token expired",
            }),
    };
}

function deviceListResponse() {
    return {
        ok: true,
        json: () =>
            Promise.resolve({
                status: 0,
                msg: "success",
                data_devices: [],
            }),
    };
}

describe("PlaudClient token refresh on -419", () => {
    it("refreshes the bearer token and retries the request once", async () => {
        const refresher = vi.fn().mockResolvedValue("fresh-token");
        const client = new PlaudClient(
            "stale-token",
            DEFAULT_PLAUD_API_BASE,
            refresher,
        );

        mockFetch
            .mockResolvedValueOnce(tokenExpiredResponse())
            .mockResolvedValueOnce(deviceListResponse());

        const result = await client.listDevices();

        expect(refresher).toHaveBeenCalledTimes(1);
        expect(refresher).toHaveBeenCalledWith(DEFAULT_PLAUD_API_BASE);
        // Retry must carry the refreshed token, not the stale one.
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe(
            "Bearer fresh-token",
        );
        expect(result.status).toBe(0);
    });

    it("does not loop: a second -419 after refresh surfaces the error", async () => {
        const refresher = vi.fn().mockResolvedValue("fresh-token");
        const client = new PlaudClient(
            "stale-token",
            DEFAULT_PLAUD_API_BASE,
            refresher,
        );

        mockFetch
            .mockResolvedValueOnce(tokenExpiredResponse())
            .mockResolvedValueOnce(tokenExpiredResponse());

        await expect(client.listDevices()).rejects.toThrow("-419");
        expect(refresher).toHaveBeenCalledTimes(1);
    });

    it("throws the -419 error when no refresher is configured", async () => {
        const client = new PlaudClient("stale-token");
        mockFetch.mockResolvedValueOnce(tokenExpiredResponse());

        await expect(client.listDevices()).rejects.toThrow("-419");
    });

    it("surfaces the original error when the refresh itself fails", async () => {
        const refresher = vi
            .fn()
            .mockRejectedValue(new Error("refresh endpoint down"));
        const client = new PlaudClient(
            "stale-token",
            DEFAULT_PLAUD_API_BASE,
            refresher,
        );

        mockFetch.mockResolvedValueOnce(tokenExpiredResponse());

        await expect(client.listDevices()).rejects.toThrow("-419");
        expect(refresher).toHaveBeenCalledTimes(1);
    });
});
