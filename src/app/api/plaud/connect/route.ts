import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { plaudConnections, plaudDevices } from "@/db/schema";
import { auth } from "@/lib/auth";
import { encrypt } from "@/lib/encryption";
import { PlaudClient } from "@/lib/plaud/client";
import {
    DEFAULT_SERVER_KEY,
    PLAUD_SERVERS,
    type PlaudServerKey,
} from "@/lib/plaud/servers";
import {
    describeTokens,
    type ParsedPlaudCredentials,
    parseSessionTokens,
} from "@/lib/plaud/token-info";

export async function POST(request: Request) {
    try {
        const session = await auth.api.getSession({
            headers: request.headers,
        });

        if (!session?.user) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }

        const body = (await request.json()) as {
            sessionTokens?: unknown;
            bearerToken?: unknown;
            refreshToken?: unknown;
            server?: unknown;
        };

        // Preferred input: the whole `pld_session.tokens` value from
        // web.plaud.ai, which carries both tokens. The separate fields remain
        // as a fallback.
        let credentials: ParsedPlaudCredentials | null = null;
        if (
            typeof body.sessionTokens === "string" &&
            body.sessionTokens.trim()
        ) {
            credentials = parseSessionTokens(body.sessionTokens);
            if (!credentials) {
                return NextResponse.json(
                    {
                        error: "Could not read the pasted session. Expected the value of pld_session.tokens (JSON with a byWsId entry).",
                    },
                    { status: 400 },
                );
            }
        } else if (typeof body.bearerToken === "string") {
            credentials = describeTokens(
                body.bearerToken,
                typeof body.refreshToken === "string"
                    ? body.refreshToken
                    : null,
            );
        }

        if (!credentials) {
            return NextResponse.json(
                { error: "Bearer token is required" },
                { status: 400 },
            );
        }

        const { bearerToken } = credentials;

        // Optional: the refresh token enables server-side rotation of the
        // bearer token before it expires, so the connection does not need a
        // manual reconnect every 24 hours.
        const encryptedRefreshToken = credentials.refreshToken
            ? encrypt(credentials.refreshToken)
            : null;

        // An explicit choice wins; otherwise the token's own `region` claim
        // decides, and only then the default. A wrong guess is still
        // corrected by the -302 redirect during validation below.
        const requestedKey =
            typeof body.server === "string" && body.server !== "auto"
                ? body.server
                : null;
        const resolvedKey: string =
            requestedKey ?? credentials.serverKey ?? DEFAULT_SERVER_KEY;
        if (!Object.hasOwn(PLAUD_SERVERS, resolvedKey)) {
            return NextResponse.json(
                { error: `Unknown server: ${resolvedKey}` },
                { status: 400 },
            );
        }

        const apiBase = PLAUD_SERVERS[resolvedKey as PlaudServerKey].apiBase;
        const client = new PlaudClient(bearerToken, apiBase);

        // Validate by listing devices. This also triggers the region
        // auto-redirect, so afterwards client.getApiBase() may differ from
        // the picked server — we persist whatever the client ended on.
        let deviceList: Awaited<ReturnType<typeof client.listDevices>>;
        try {
            deviceList = await client.listDevices();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Invalid bearer token";
            return NextResponse.json({ error: message }, { status: 400 });
        }

        const resolvedApiBase = client.getApiBase();

        const encryptedToken = encrypt(bearerToken);

        const [existingConnection] = await db
            .select()
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, session.user.id))
            .limit(1);

        if (existingConnection) {
            await db
                .update(plaudConnections)
                .set({
                    bearerToken: encryptedToken,
                    apiBase: resolvedApiBase,
                    // Only overwrite the stored refresh token when a new one is
                    // supplied, so a bearer-only reconnect keeps auto-refresh.
                    ...(encryptedRefreshToken
                        ? {
                              refreshToken: encryptedRefreshToken,
                              refreshExpiresAt: credentials.refreshExpiresAt,
                          }
                        : {}),
                    accessExpiresAt: credentials.accessExpiresAt,
                    // A fresh token clears any prior expiry error.
                    syncError: null,
                    syncErrorAt: null,
                    refreshError: null,
                    refreshErrorAt: null,
                    updatedAt: new Date(),
                })
                .where(eq(plaudConnections.id, existingConnection.id));
        } else {
            await db.insert(plaudConnections).values({
                userId: session.user.id,
                bearerToken: encryptedToken,
                refreshToken: encryptedRefreshToken,
                apiBase: resolvedApiBase,
                accessExpiresAt: credentials.accessExpiresAt,
                refreshExpiresAt: credentials.refreshExpiresAt,
            });
        }

        const devices = deviceList.data_devices ?? [];
        for (const device of devices) {
            const [existingDevice] = await db
                .select()
                .from(plaudDevices)
                .where(
                    and(
                        eq(plaudDevices.userId, session.user.id),
                        eq(plaudDevices.serialNumber, device.sn),
                    ),
                )
                .limit(1);

            if (existingDevice) {
                await db
                    .update(plaudDevices)
                    .set({
                        name: device.name,
                        model: device.model,
                        versionNumber: device.version_number,
                        updatedAt: new Date(),
                    })
                    .where(eq(plaudDevices.id, existingDevice.id));
            } else {
                await db.insert(plaudDevices).values({
                    userId: session.user.id,
                    serialNumber: device.sn,
                    name: device.name,
                    model: device.model,
                    versionNumber: device.version_number,
                });
            }
        }

        // Bearer-only reconnect keeps the refresh token that was already
        // stored, so report what is actually on the row.
        const hasRefreshToken =
            !!encryptedRefreshToken || !!existingConnection?.refreshToken;
        const refreshExpiresAt = encryptedRefreshToken
            ? credentials.refreshExpiresAt
            : (existingConnection?.refreshExpiresAt ?? null);

        return NextResponse.json({
            success: true,
            devices,
            apiBase: resolvedApiBase,
            region: credentials.region,
            accessExpiresAt: credentials.accessExpiresAt,
            refreshExpiresAt,
            hasRefreshToken,
        });
    } catch (error) {
        console.error("Error connecting to Plaud:", error);
        return NextResponse.json(
            { error: "Failed to connect to Plaud" },
            { status: 500 },
        );
    }
}
