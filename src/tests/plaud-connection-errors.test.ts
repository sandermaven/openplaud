import { describe, expect, it } from "vitest";

import { isConnectionExpiredError } from "../lib/plaud/connection-errors";

describe("isConnectionExpiredError", () => {
    it("matches an expired workspace token", () => {
        expect(
            isConnectionExpiredError(
                "Sync failed: Plaud API error (-419): workspace token expired",
            ),
        ).toBe(true);
    });

    it("matches a rejected token refresh", () => {
        expect(
            isConnectionExpiredError(
                "Plaud token refresh returned status -420",
            ),
        ).toBe(true);
    });

    it("matches an account migrated to Plaud 4.0", () => {
        expect(
            isConnectionExpiredError(
                "Failed to sync Meeting.mp3: Error: Plaud API error (-1800907): " +
                    "Account migrated to 4.0. Please update and reinitialize.",
            ),
        ).toBe(true);
    });

    it("leaves transient failures alone", () => {
        expect(
            isConnectionExpiredError(
                "Failed to sync Meeting.mp3: Error: Plaud API error (500): Internal Server Error",
            ),
        ).toBe(false);
        expect(isConnectionExpiredError("Email notification failed")).toBe(
            false,
        );
    });
});
