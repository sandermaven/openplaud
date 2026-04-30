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
import { compressAudioForTranscription } from "@/lib/transcription/compress-audio";
import { estimateTranscriptionCost } from "@/lib/transcription/pricing";

// Whisper's verbose_json returns the language as a full English name
// (e.g. "english", "dutch"), but the API's `language` parameter requires
// an ISO-639-1 code. Map known names to codes; unknown values fall through
// to undefined so the request omits `language` and Whisper auto-detects.
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
    english: "en",
    dutch: "nl",
    spanish: "es",
    french: "fr",
    german: "de",
    italian: "it",
    portuguese: "pt",
    chinese: "zh",
    japanese: "ja",
    korean: "ko",
    russian: "ru",
};

function normalizeLanguage(
    lang: string | null | undefined,
): string | undefined {
    if (!lang) return undefined;
    const lower = lang.toLowerCase().trim();
    if (lower.length === 2) return lower;
    return LANGUAGE_NAME_TO_CODE[lower];
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

        const defaultLanguage = normalizeLanguage(
            settings?.defaultTranscriptionLanguage,
        );
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

        // Compress audio and split into chunks if needed
        const chunks = await compressAudioForTranscription(
            audioBuffer,
            recording.filename,
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

        if (chunks.length > 1) {
            console.log(
                `[transcribe] Transcribing ${chunks.length} chunks for recording ${recordingId}`,
            );
        }

        const transcriptionParts: string[] = [];
        let detectedLanguage: string | null = null;
        let chunkLanguage = defaultLanguage;

        for (const chunk of chunks) {
            const audioFile = new File(
                [new Uint8Array(chunk.buffer)],
                chunk.filename,
                { type: chunk.contentType },
            );

            const transcription = await openai.audio.transcriptions.create({
                file: audioFile,
                model,
                response_format: responseFormat,
                ...(chunkLanguage ? { language: chunkLanguage } : {}),
            });

            if (supportsDiarizedJson) {
                const diarized = transcription as TranscriptionDiarized;
                transcriptionParts.push(
                    (diarized.segments ?? [])
                        .map((seg) => `${seg.speaker}: ${seg.text}`)
                        .join("\n"),
                );
            } else if (responseFormat === "verbose_json") {
                const verbose = transcription as TranscriptionVerbose;
                transcriptionParts.push(verbose.text);
                if (!detectedLanguage) {
                    detectedLanguage = verbose.language ?? null;
                    if (!chunkLanguage) {
                        chunkLanguage = normalizeLanguage(detectedLanguage);
                    }
                }
            } else {
                transcriptionParts.push(
                    typeof transcription === "string"
                        ? transcription
                        : (transcription.text ?? ""),
                );
            }
        }

        const transcriptionText = transcriptionParts.join("\n");

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
