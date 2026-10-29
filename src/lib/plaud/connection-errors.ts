/**
 * Classifying Plaud failures that only a reconnect can fix.
 *
 * Plaud signals these as app-level statuses on an HTTP 200 body, so they reach
 * us as error messages built by `PlaudClient.request`. Anything matched here
 * gets the dashboard banner + the reconnect email; everything else is treated
 * as a transient sync hiccup and stays silent.
 *
 * Known statuses, all observed in production:
 * - `-419`     workspace token expired (the access token aged out)
 * - `-420`     the refresh call itself was rejected, so rotation cannot
 *              recover the connection either
 * - `-1800907` "Account migrated to 4.0. Please update and reinitialize" —
 *              Plaud moved the account to a newer backend and the stored
 *              credentials are void
 */
const CONNECTION_ERROR_MARKERS = [
    "-419",
    "-420",
    "-1800907",
    "token expired",
    "workspace token",
    "account migrated",
    "reinitialize",
];

/** True when a sync failure means the Plaud credentials need reconnecting. */
export function isConnectionExpiredError(message: string): boolean {
    const m = message.toLowerCase();
    return CONNECTION_ERROR_MARKERS.some((marker) => m.includes(marker));
}
