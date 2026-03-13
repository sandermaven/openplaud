import { after } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AppError, createErrorResponse, ErrorCode } from "@/lib/errors";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

export async function POST(request: Request) {
    try {
        const session = await auth.api.getSession({
            headers: request.headers,
        });

        if (!session?.user) {
            const error = new AppError(
                ErrorCode.UNAUTHORIZED,
                "You must be logged in to sync recordings",
                401,
            );
            const response = createErrorResponse(error);
            return NextResponse.json(response.body, {
                status: response.status,
            });
        }

        const result = await syncRecordingsForUser(session.user.id);

        // Run transcription after the response is sent, guaranteed by Next.js
        if (result.pendingTranscriptionIds.length > 0) {
            const userId = session.user.id;
            const ids = result.pendingTranscriptionIds;
            after(async () => {
                console.log(
                    `[auto-transcribe] Starting transcription for ${ids.length} recording(s)`,
                );
                for (const recordingId of ids) {
                    const res = await transcribeRecording(userId, recordingId);
                    if (!res.success) {
                        console.error(
                            `[auto-transcribe] Failed for ${recordingId}: ${res.error}`,
                        );
                    } else {
                        console.log(
                            `[auto-transcribe] Completed ${recordingId}`,
                        );
                    }
                }
            });
        }

        return NextResponse.json({
            success: true,
            newRecordings: result.newRecordings,
            updatedRecordings: result.updatedRecordings,
            pendingTranscriptions: result.pendingTranscriptionIds.length,
            errors: result.errors,
        });
    } catch (error) {
        console.error("Error syncing recordings:", error);
        const response = createErrorResponse(error, ErrorCode.PLAUD_API_ERROR);
        return NextResponse.json(response.body, { status: response.status });
    }
}
