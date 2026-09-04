import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AppError, createErrorResponse, ErrorCode } from "@/lib/errors";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";
import { enqueueTranscriptions } from "@/lib/transcription/queue";

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

        // Hand the work to the background queue and answer now. The queue
        // dedupes on recording id, so the recordings this sync re-reports as
        // pending (it returns *all* untranscribed ones, every time) don't pile
        // up behind each other on the next sync five minutes from now.
        const added = enqueueTranscriptions(
            session.user.id,
            result.pendingTranscriptionIds,
        );
        if (added > 0) {
            console.log(
                `[auto-transcribe] Queued ${added} of ${result.pendingTranscriptionIds.length} pending recording(s)`,
            );
        }

        return NextResponse.json({
            success: true,
            newRecordings: result.newRecordings,
            updatedRecordings: result.updatedRecordings,
            pendingTranscriptions: result.pendingTranscriptionIds.length,
            queuedTranscriptions: added,
            errors: result.errors,
        });
    } catch (error) {
        console.error("Error syncing recordings:", error);
        const response = createErrorResponse(error, ErrorCode.PLAUD_API_ERROR);
        return NextResponse.json(response.body, { status: response.status });
    }
}
