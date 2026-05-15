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

        const { bearerToken, server: serverKey } = await request.json();

        if (!bearerToken) {
            return NextResponse.json(
                { error: "Bearer token is required" },
                { status: 400 },
            );
        }

        const resolvedKey = (serverKey ?? DEFAULT_SERVER_KEY) as string;
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
        console.log("Plaud device list response:", JSON.stringify(deviceList));

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
                    updatedAt: new Date(),
                })
                .where(eq(plaudConnections.id, existingConnection.id));
        } else {
            await db.insert(plaudConnections).values({
                userId: session.user.id,
                bearerToken: encryptedToken,
                apiBase: resolvedApiBase,
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

        return NextResponse.json({
            success: true,
            devices,
        });
    } catch (error) {
        console.error("Error connecting to Plaud:", error);
        return NextResponse.json(
            { error: "Failed to connect to Plaud" },
            { status: 500 },
        );
    }
}
