import { createReadStream, existsSync, statSync } from "node:fs";
import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { plaudConnections, recordings } from "@/db/schema";
import { auth } from "@/lib/auth";
import { createPlaudClient } from "@/lib/plaud/client";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { LocalStorage } from "@/lib/storage/local-storage";
import { S3Storage } from "@/lib/storage/s3-storage";

function getContentType(path: string): string {
    if (path.endsWith(".mp3")) return "audio/mpeg";
    if (path.endsWith(".opus")) return "audio/opus";
    if (path.endsWith(".wav")) return "audio/wav";
    if (path.endsWith(".m4a")) return "audio/mp4";
    if (path.endsWith(".ogg")) return "audio/ogg";
    if (path.endsWith(".webm")) return "audio/webm";
    return "audio/mpeg";
}

function readableNodeToWeb(nodeStream: Readable): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            nodeStream.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on("end", () => {
                controller.close();
            });
            nodeStream.on("error", (err) => {
                controller.error(err);
            });
        },
        cancel() {
            nodeStream.destroy();
        },
    });
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
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

        const { id } = await params;

        const [recording] = await db
            .select()
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, session.user.id),
                ),
            )
            .limit(1);

        if (!recording) {
            return NextResponse.json(
                { error: "Recording not found" },
                { status: 404 },
            );
        }

        const storage = await createUserStorageProvider(session.user.id);

        // S3: redirect to presigned URL — zero server memory usage
        if (storage instanceof S3Storage) {
            const signedUrl = await storage.getSignedUrl(
                recording.storagePath,
                3600,
            );
            return NextResponse.redirect(signedUrl, 302);
        }

        // Local storage: stream from disk if file exists
        if (storage instanceof LocalStorage) {
            const filePath = storage.getFilePath(recording.storagePath);

            if (existsSync(filePath)) {
                const stat = statSync(filePath);
                const fileSize = stat.size;
                const contentType = getContentType(recording.storagePath);
                const rangeHeader = request.headers.get("range");

                if (rangeHeader) {
                    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
                    if (rangeMatch) {
                        const start = parseInt(rangeMatch[1], 10);
                        const end = rangeMatch[2]
                            ? parseInt(rangeMatch[2], 10)
                            : fileSize - 1;

                        if (
                            start < 0 ||
                            start >= fileSize ||
                            end < 0 ||
                            end >= fileSize ||
                            start > end
                        ) {
                            return new NextResponse(null, {
                                status: 416,
                                headers: {
                                    "Content-Range": `bytes */${fileSize}`,
                                },
                            });
                        }

                        const chunkSize = end - start + 1;
                        const stream = createReadStream(filePath, {
                            start,
                            end,
                        });

                        return new NextResponse(readableNodeToWeb(stream), {
                            status: 206,
                            headers: {
                                "Content-Type": contentType,
                                "Content-Length": chunkSize.toString(),
                                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                                "Accept-Ranges": "bytes",
                                "Cache-Control":
                                    "public, max-age=31536000, immutable",
                            },
                        });
                    }
                }

                const stream = createReadStream(filePath);

                return new NextResponse(readableNodeToWeb(stream), {
                    headers: {
                        "Content-Type": contentType,
                        "Content-Length": fileSize.toString(),
                        "Accept-Ranges": "bytes",
                        "Cache-Control": "public, max-age=31536000, immutable",
                    },
                });
            }
        }

        // File not on disk (cleaned up after transcription) — proxy from Plaud temp URL
        if (recording.plaudFileId) {
            const [connection] = await db
                .select()
                .from(plaudConnections)
                .where(eq(plaudConnections.userId, session.user.id))
                .limit(1);

            if (!connection) {
                console.error(
                    `Audio ${id}: no Plaud connection found for user ${session.user.id}`,
                );
                return NextResponse.json(
                    {
                        error: "No Plaud connection found. Please reconnect your Plaud account.",
                    },
                    { status: 404 },
                );
            }

            let plaudClient;
            try {
                plaudClient = await createPlaudClient(
                    connection.bearerToken,
                    connection.apiBase,
                );
            } catch (decryptError) {
                console.error(
                    `Audio ${id}: failed to create Plaud client:`,
                    decryptError,
                );
                return NextResponse.json(
                    {
                        error: "Failed to authenticate with Plaud. Please reconnect your account.",
                    },
                    { status: 502 },
                );
            }

            let tempUrlResponse;
            try {
                tempUrlResponse = await plaudClient.getTempUrl(
                    recording.plaudFileId,
                    false,
                );
            } catch (apiError) {
                console.error(
                    `Audio ${id}: Plaud getTempUrl failed for file ${recording.plaudFileId}:`,
                    apiError,
                );
                return NextResponse.json(
                    {
                        error: "Plaud session expired. Please reconnect your Plaud account.",
                    },
                    { status: 502 },
                );
            }

            if (!tempUrlResponse?.temp_url) {
                console.error(
                    `Audio ${id}: Plaud returned empty temp_url for file ${recording.plaudFileId}`,
                );
                return NextResponse.json(
                    { error: "Plaud returned no download URL for this file." },
                    { status: 502 },
                );
            }

            // Proxy the audio stream instead of redirecting to avoid
            // cross-origin issues with iOS Safari's audio element
            const fetchHeaders: HeadersInit = {};
            const rangeHeader = request.headers.get("range");
            if (rangeHeader) {
                fetchHeaders["Range"] = rangeHeader;
            }

            const audioResponse = await fetch(tempUrlResponse.temp_url, {
                headers: fetchHeaders,
            });

            if (!audioResponse.ok && audioResponse.status !== 206) {
                console.error(
                    `Audio ${id}: fetch from Plaud temp URL failed with status ${audioResponse.status}`,
                );
                return NextResponse.json(
                    {
                        error: `Failed to download audio from Plaud (HTTP ${audioResponse.status})`,
                    },
                    { status: 502 },
                );
            }

            const contentType =
                audioResponse.headers.get("content-type") ||
                getContentType(recording.storagePath);
            const responseHeaders: Record<string, string> = {
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=3600",
            };

            const contentLength =
                audioResponse.headers.get("content-length");
            if (contentLength) {
                responseHeaders["Content-Length"] = contentLength;
            }

            const contentRange =
                audioResponse.headers.get("content-range");
            if (contentRange) {
                responseHeaders["Content-Range"] = contentRange;
            }

            return new NextResponse(audioResponse.body, {
                status: audioResponse.status,
                headers: responseHeaders,
            });
        }

        return NextResponse.json(
            { error: "Audio file not available" },
            { status: 404 },
        );
    } catch (error) {
        console.error("Error streaming audio:", error);
        return NextResponse.json(
            { error: "Failed to stream audio" },
            { status: 500 },
        );
    }
}
