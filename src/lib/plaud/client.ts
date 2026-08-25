import type {
    PlaudApiError,
    PlaudDeviceListResponse,
    PlaudRecordingsResponse,
    PlaudTempUrlResponse,
} from "@/types/plaud";
import type { TokenRefresher } from "./refresh";
import { DEFAULT_SERVER_KEY, PLAUD_SERVERS } from "./servers";

export interface PlaudUpdateFilenameResponse {
    status: number;
    msg: string;
    data_file?: unknown;
}

export const DEFAULT_PLAUD_API_BASE = PLAUD_SERVERS[DEFAULT_SERVER_KEY].apiBase;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Plaud's API sits behind Cloudflare's bot WAF, which blocks requests
 * carrying a non-browser User-Agent (e.g. the default `Bun/x` or `undici`)
 * with an HTML 403 page. Sending a realistic browser UA keeps requests from
 * being silently turned into unparseable HTML.
 */
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36";

/**
 * Parse a response body as JSON, turning the cryptic
 * "Unrecognized token '<'" SyntaxError (an HTML body, typically a
 * Cloudflare/proxy block or error page) into a readable error that names
 * the HTTP status.
 */
async function parseJsonBody<T>(response: Response): Promise<T> {
    try {
        return (await response.json()) as T;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(
                `Plaud API returned a non-JSON response (HTTP ${response.status}). ` +
                    "The request was likely blocked by an upstream proxy or WAF.",
            );
        }
        throw error;
    }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when an app-level Plaud error means the workspace access token expired
 * (status -419), so a refresh + retry is worth attempting.
 */
function isTokenExpired(status: number, msg?: string): boolean {
    if (status === -419) return true;
    const m = (msg ?? "").toLowerCase();
    return m.includes("token expired") || m.includes("workspace token");
}

/**
 * Plaud API Client
 * Handles all communication with Plaud API
 */
export class PlaudClient {
    private bearerToken: string;
    private apiBase: string;
    private refresher?: TokenRefresher;

    constructor(
        bearerToken: string,
        apiBase: string = DEFAULT_PLAUD_API_BASE,
        refresher?: TokenRefresher,
    ) {
        this.bearerToken = bearerToken;
        this.apiBase = apiBase;
        this.refresher = refresher;
    }

    /**
     * The API base currently in use. May differ from the constructor value
     * if Plaud redirected us to a region-specific domain — callers should
     * persist this so future requests skip the redirect round-trip.
     */
    getApiBase(): string {
        return this.apiBase;
    }

    /**
     * Make authenticated request to Plaud API with retry logic.
     *
     * Plaud signals application-level errors with HTTP 200 and a negative
     * `status` field in the body (e.g. -302 "user region mismatch"). We must
     * inspect the body, not just `response.ok`, or these errors are silently
     * returned as if they were valid data.
     */
    private async request<T>(
        endpoint: string,
        options?: RequestInit,
        retryCount = 0,
        regionRedirected = false,
        refreshed = false,
    ): Promise<T> {
        const url = `${this.apiBase}${endpoint}`;

        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...options?.headers,
                    Authorization: `Bearer ${this.bearerToken}`,
                    "Content-Type": "application/json",
                    "User-Agent": BROWSER_USER_AGENT,
                },
            });

            if (response.status === 429 && retryCount < MAX_RETRIES) {
                const retryAfter = response.headers.get("Retry-After");
                const delay = retryAfter
                    ? Number.parseInt(retryAfter, 10) * 1000
                    : INITIAL_RETRY_DELAY * 2 ** retryCount; // Exponential backoff
                await sleep(delay);
                return this.request<T>(
                    endpoint,
                    options,
                    retryCount + 1,
                    regionRedirected,
                    refreshed,
                );
            }

            if (!response.ok) {
                const error = await parseJsonBody<PlaudApiError>(response);
                const errorMessage = `Plaud API error (${response.status}): ${error.msg || response.statusText}`;

                if (
                    response.status >= 500 &&
                    response.status < 600 &&
                    retryCount < MAX_RETRIES
                ) {
                    const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                    await sleep(delay);
                    return this.request<T>(
                        endpoint,
                        options,
                        retryCount + 1,
                        regionRedirected,
                    );
                }

                throw new Error(errorMessage);
            }

            const data = await parseJsonBody<
                T & {
                    status?: number;
                    msg?: string;
                    data?: { domains?: { api?: string } };
                }
            >(response);

            // Plaud uses HTTP 200 with a negative `status` for app-level
            // errors. -302 means "wrong region" and carries the correct
            // domain — follow it once, then surface any remaining error.
            if (typeof data.status === "number" && data.status < 0) {
                const redirectBase = data.data?.domains?.api;
                if (
                    data.status === -302 &&
                    typeof redirectBase === "string" &&
                    redirectBase !== this.apiBase &&
                    !regionRedirected
                ) {
                    this.apiBase = redirectBase;
                    return this.request<T>(
                        endpoint,
                        options,
                        0,
                        true,
                        refreshed,
                    );
                }

                // -419 = "workspace token expired". If we have a refresh token,
                // rotate the bearer token once and retry instead of failing.
                if (
                    isTokenExpired(data.status, data.msg) &&
                    this.refresher &&
                    !refreshed
                ) {
                    const newToken = await this.refresher(this.apiBase).catch(
                        (error) => {
                            console.error(
                                "[plaud] token refresh failed:",
                                error,
                            );
                            return null;
                        },
                    );
                    if (newToken) {
                        this.bearerToken = newToken;
                        return this.request<T>(
                            endpoint,
                            options,
                            0,
                            regionRedirected,
                            true,
                        );
                    }
                }

                throw new Error(
                    `Plaud API error (${data.status}): ${data.msg ?? "unknown error"}`,
                );
            }

            return data as T;
        } catch (error) {
            if (
                error instanceof TypeError &&
                error.message.includes("fetch") &&
                retryCount < MAX_RETRIES
            ) {
                const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                await sleep(delay);
                return this.request<T>(
                    endpoint,
                    options,
                    retryCount + 1,
                    regionRedirected,
                    refreshed,
                );
            }

            if (error instanceof Error) {
                throw error;
            }
            throw new Error(
                `Failed to make request to Plaud API: ${String(error)}`,
            );
        }
    }

    /**
     * List all devices associated with the account
     */
    async listDevices(): Promise<PlaudDeviceListResponse> {
        return this.request<PlaudDeviceListResponse>("/device/list");
    }

    /**
     * Get all recordings
     * @param skip - Number of recordings to skip
     * @param limit - Maximum number of recordings to return
     * @param isTrash - Whether to get trashed recordings (0 = active, 1 = trash)
     * @param sortBy - Field to sort by (default: edit_time)
     * @param isDesc - Sort in descending order (default: true)
     */
    async getRecordings(
        skip: number = 0,
        limit: number = 99999,
        isTrash: number = 0,
        sortBy: string = "edit_time",
        isDesc: boolean = true,
    ): Promise<PlaudRecordingsResponse> {
        const params = new URLSearchParams({
            skip: skip.toString(),
            limit: limit.toString(),
            is_trash: isTrash.toString(),
            sort_by: sortBy,
            is_desc: isDesc.toString(),
        });

        return this.request<PlaudRecordingsResponse>(
            `/file/simple/web?${params.toString()}`,
        );
    }

    /**
     * Get temporary URL for downloading audio file
     * @param fileId - The recording file ID
     * @param isOpus - Whether to get OPUS format URL (default: true)
     */
    async getTempUrl(
        fileId: string,
        isOpus: boolean = true,
    ): Promise<PlaudTempUrlResponse> {
        const params = new URLSearchParams({
            is_opus: isOpus ? "1" : "0",
        });

        return this.request<PlaudTempUrlResponse>(
            `/file/temp-url/${fileId}?${params.toString()}`,
        );
    }

    /**
     * Download audio file as buffer
     * @param fileId - The recording file ID
     * @param preferOpus - Whether to prefer OPUS format (smaller size)
     */
    async downloadRecording(
        fileId: string,
        preferOpus: boolean = true,
    ): Promise<Buffer> {
        try {
            const tempUrlResponse = await this.getTempUrl(fileId, preferOpus);
            const downloadUrl =
                preferOpus && tempUrlResponse.temp_url_opus
                    ? tempUrlResponse.temp_url_opus
                    : tempUrlResponse.temp_url;

            const response = await fetch(downloadUrl);
            if (!response.ok) {
                throw new Error(
                    `Failed to download file: ${response.statusText}`,
                );
            }

            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            throw new Error(
                `Failed to download recording: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * Test connection to Plaud API
     * Returns true if bearer token is valid
     */
    async testConnection(): Promise<boolean> {
        try {
            await this.listDevices();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Update filename for a recording
     * @param fileId - The recording file ID
     * @param filename - New filename to set
     */
    async updateFilename(
        fileId: string,
        filename: string,
    ): Promise<PlaudUpdateFilenameResponse> {
        return this.request<PlaudUpdateFilenameResponse>(`/file/${fileId}`, {
            method: "PATCH",
            body: JSON.stringify({ filename }),
        });
    }
}

/**
 * Create Plaud client from an encrypted bearer token.
 *
 * When `refresh` is supplied and the connection has an encrypted refresh
 * token, the client auto-rotates the bearer token on -419 and persists the
 * new tokens, so an expired workspace token self-heals without a reconnect.
 */
export async function createPlaudClient(
    encryptedToken: string,
    apiBase: string = DEFAULT_PLAUD_API_BASE,
    refresh?: { connectionId: string; encryptedRefreshToken: string | null },
): Promise<PlaudClient> {
    const { decrypt } = await import("../encryption");
    const bearerToken = decrypt(encryptedToken);

    let refresher: TokenRefresher | undefined;
    if (refresh?.encryptedRefreshToken) {
        const { createTokenRefresher } = await import("./refresh");
        refresher = createTokenRefresher(
            refresh.connectionId,
            refresh.encryptedRefreshToken,
        );
    }

    return new PlaudClient(bearerToken, apiBase, refresher);
}

export * from "./types";
