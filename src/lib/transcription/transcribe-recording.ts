import { and, eq } from "drizzle-orm";
import { OpenAI } from "openai";
import type {
    TranscriptionDiarized,
    TranscriptionVerbose,
} from "openai/resources/audio/transcriptions";
import { db } from "@/db";
import {
    apiCredentials,
    plaudConnections,
    recordings,
    transcriptions,
    userSettings,
} from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { decrypt } from "@/lib/encryption";
import { syncTranscriptionToNotion } from "@/lib/notion/sync";
import { createPlaudClient } from "@/lib/plaud/client";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { estimateTranscriptionCost } from "@/lib/transcription/pricing";

// OpenAI Whisper API limit: 25 MB
const MAX_TRANSCRIPTION_FILE_SIZE = 25 * 1024 * 1024;

// Supported audio extensions for OpenAI Whisper
const SUPPORTED_EXTENSIONS = new Set([
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".mpeg",
    ".mpga",
    ".oga",
    ".ogg",
    ".wav",
    ".webm",
]);

/**
 * Insert a placeholder transcription to prevent endless retries for
 * recordings that can never be transcribed (too large, wrong format, etc.).
 */
async function markTranscriptionFailed(
    recordingId: string,
    userId: string,
    reason: string,
): Promise<void> {
    const [existing] = await db
        .select()
        .from(transcriptions)
        .where(eq(transcriptions.recordingId, recordingId))
        .limit(1);

    if (existing) {
        await db
            .update(transcriptions)
            .set({ text: `[Transcription skipped: ${reason}]` })
            .where(eq(transcriptions.id, existing.id));
    } else {
        await db.insert(transcriptions).values({
            recordingId,
            userId,
            text: `[Transcription skipped: ${reason}]`,
            transcriptionType: "server",
        });
    }
}

/**
 * Normalize filename extension to one OpenAI accepts.
 * E.g. .opus → .ogg (Opus audio is typically in OGG container).
 */
function normalizeFilenameForWhisper(filename: string): string {
    if (filename.endsWith(".opus")) {
        return `${filename.slice(0, -5)}.ogg`;
    }
    return filename;
}

export async function transcribeRecording(
    userId: string,
    recordingId: string,
): Promise<{ success: boolean; error?: string }> {
    try {
        const [recording] = await db
            .select()
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .limit(1);

        if (!recording) {
            return { success: false, error: "Recording not found" };
        }

        const [existingTranscription] = await db
            .select()
            .from(transcriptions)
            .where(eq(transcriptions.recordingId, recordingId))
            .limit(1);

        if (existingTranscription?.text) {
            return { success: true };
        }

        // Check file size before downloading — 25 MB is OpenAI Whisper's limit
        if (recording.filesize > MAX_TRANSCRIPTION_FILE_SIZE) {
            const sizeMB = (recording.filesize / 1024 / 1024).toFixed(1);
            const reason = `File size ${sizeMB}MB exceeds 25MB limit`;
            console.warn(
                `[transcription] Skipping ${recordingId}: ${reason}`,
            );
            await markTranscriptionFailed(recordingId, userId, reason);
            return { success: false, error: reason };
        }

        // Check file format — OpenAI Whisper only supports specific formats
        const ext = recording.storagePath
            .slice(recording.storagePath.lastIndexOf("."))
            .toLowerCase();
        if (
            ext &&
            !SUPPORTED_EXTENSIONS.has(ext) &&
            ext !== ".opus" // .opus will be renamed to .ogg
        ) {
            const reason = `Unsupported audio format: ${ext}`;
            console.warn(
                `[transcription] Skipping ${recordingId}: ${reason}`,
            );
            await markTranscriptionFailed(recordingId, userId, reason);
            return { success: false, error: reason };
        }

        const [credentials] = await db
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, userId),
                    eq(apiCredentials.isDefaultTranscription, true),
                ),
            )
            .limit(1);

        if (!credentials) {
            return { success: false, error: "No transcription API configured" };
        }

        const [settings] = await db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);

        const defaultLanguage =
            settings?.defaultTranscriptionLanguage || undefined;
        const quality = settings?.transcriptionQuality || "balanced";
        const autoGenerateTitle = settings?.autoGenerateTitle ?? true;
        const syncTitleToPlaud = settings?.syncTitleToPlaud ?? false;

        void quality;

        const apiKey = decrypt(credentials.apiKey);
        const openai = new OpenAI({
            apiKey,
            baseURL: credentials.baseUrl || undefined,
        });

        const storage = await createUserStorageProvider(userId);
        let audioBuffer: Buffer;
        try {
            audioBuffer = await storage.downloadFile(recording.storagePath);
        } catch {
            // File may have been cleaned up — re-download from Plaud
            const [connection] = await db
                .select()
                .from(plaudConnections)
                .where(eq(plaudConnections.userId, userId))
                .limit(1);
            if (!connection) {
                return {
                    success: false,
                    error: "No Plaud connection to re-download audio",
                };
            }
            const plaudClient = await createPlaudClient(
                connection.bearerToken,
                connection.apiBase,
            );
            audioBuffer = await plaudClient.downloadRecording(
                recording.plaudFileId,
                false,
            );
        }

        const contentType = recording.storagePath.endsWith(".mp3")
            ? "audio/mpeg"
            : recording.storagePath.endsWith(".opus")
              ? "audio/ogg"
              : "audio/mpeg";
        const normalizedFilename = normalizeFilenameForWhisper(
            recording.filename,
        );
        const audioFile = new File(
            [new Uint8Array(audioBuffer)],
            normalizedFilename,
            { type: contentType },
        );

        const model = credentials.defaultModel || "whisper-1";

        const isGpt4o = model.startsWith("gpt-4o");
        const supportsDiarizedJson =
            model.includes("diarize") || model.includes("diarized");

        const responseFormat = supportsDiarizedJson
            ? ("diarized_json" as const)
            : isGpt4o
              ? ("json" as const)
              : ("verbose_json" as const);

        const transcription = await openai.audio.transcriptions.create({
            file: audioFile,
            model,
            response_format: responseFormat,
            ...(defaultLanguage ? { language: defaultLanguage } : {}),
        });

        let transcriptionText: string;
        let detectedLanguage: string | null = null;

        if (supportsDiarizedJson) {
            const diarized = transcription as TranscriptionDiarized;
            transcriptionText = (diarized.segments ?? [])
                .map((seg) => `${seg.speaker}: ${seg.text}`)
                .join("\n");
            // TranscriptionDiarized doesn't expose language
        } else if (responseFormat === "verbose_json") {
            const verbose = transcription as TranscriptionVerbose;
            transcriptionText = verbose.text;
            detectedLanguage = verbose.language ?? null;
        } else {
            transcriptionText =
                typeof transcription === "string"
                    ? transcription
                    : (transcription.text ?? "");
        }

        const costEstimate = estimateTranscriptionCost(
            credentials.provider,
            model,
            recording.duration,
        );

        if (existingTranscription) {
            await db
                .update(transcriptions)
                .set({
                    text: transcriptionText,
                    detectedLanguage,
                    transcriptionType: "server",
                    provider: credentials.provider,
                    model: credentials.defaultModel || "whisper-1",
                    costEstimate,
                })
                .where(eq(transcriptions.id, existingTranscription.id));
        } else {
            await db.insert(transcriptions).values({
                recordingId,
                userId,
                text: transcriptionText,
                detectedLanguage,
                transcriptionType: "server",
                provider: credentials.provider,
                model: credentials.defaultModel || "whisper-1",
                costEstimate,
            });
        }

        if (autoGenerateTitle && transcriptionText.trim()) {
            try {
                const generatedTitle = await generateTitleFromTranscription(
                    userId,
                    transcriptionText,
                );

                if (generatedTitle) {
                    await db
                        .update(recordings)
                        .set({
                            filename: generatedTitle,
                            updatedAt: new Date(),
                        })
                        .where(eq(recordings.id, recordingId));

                    if (syncTitleToPlaud) {
                        try {
                            const [connection] = await db
                                .select()
                                .from(plaudConnections)
                                .where(eq(plaudConnections.userId, userId))
                                .limit(1);

                            if (connection) {
                                const plaudClient = await createPlaudClient(
                                    connection.bearerToken,
                                    connection.apiBase,
                                );
                                await plaudClient.updateFilename(
                                    recording.plaudFileId,
                                    generatedTitle,
                                );
                            }
                        } catch (error) {
                            console.error(
                                "Failed to sync title to Plaud:",
                                error,
                            );
                        }
                    }
                }
            } catch (error) {
                console.error("Failed to generate title:", error);
            }
        }

        // Clean up local audio file after successful transcription
        try {
            await storage.deleteFile(recording.storagePath);
        } catch (error) {
            console.error("Failed to delete audio after transcription:", error);
        }

        // Auto-sync to Scribe (non-blocking)
        try {
            const [txn] = await db
                .select({ id: transcriptions.id })
                .from(transcriptions)
                .where(eq(transcriptions.recordingId, recordingId))
                .limit(1);

            if (txn) {
                syncTranscriptionToNotion(txn.id).catch((err) =>
                    console.error("Scribe auto-sync failed:", err),
                );
            }
        } catch (error) {
            console.error("Scribe sync trigger failed:", error);
        }

        return { success: true };
    } catch (error) {
        console.error("Error transcribing recording:", error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : "Transcription failed",
        };
    }
}
