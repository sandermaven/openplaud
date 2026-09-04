import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiCredentials, recordings, transcriptions } from "@/db/schema";
import { auth } from "@/lib/auth";
import {
    clearTranscriptionError,
    enqueueTranscription,
    getTranscriptionJobState,
} from "@/lib/transcription/queue";

// Whisper only gets a forced language for the options the UI offers. Anything
// else (including "auto") means auto-detect.
const ALLOWED_LANGUAGES = new Set(["nl", "en"]);

async function requireOwnedRecording(
    userId: string,
    recordingId: string,
): Promise<boolean> {
    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        )
        .limit(1);
    return !!recording;
}

async function loadTranscription(recordingId: string) {
    const [row] = await db
        .select({
            text: transcriptions.text,
            detectedLanguage: transcriptions.detectedLanguage,
            costEstimate: transcriptions.costEstimate,
        })
        .from(transcriptions)
        .where(eq(transcriptions.recordingId, recordingId))
        .limit(1);
    return row ?? null;
}

/**
 * Report what the server is doing with this recording.
 *
 * The transcription itself runs on a background queue, so this is the only way
 * the client can tell a job apart from a finished one. It survives a reload:
 * the panel asks on mount and picks a running job back up, instead of showing
 * an idle button while the server is still working.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    if (!(await requireOwnedRecording(session.user.id, id))) {
        return NextResponse.json(
            { error: "Recording not found" },
            { status: 404 },
        );
    }

    const state = getTranscriptionJobState(id);
    // A remembered failure is delivered once; the client turns it into a toast.
    if (state.error) clearTranscriptionError(id);

    return NextResponse.json({
        status: state.status,
        position: state.position,
        queueLength: state.queueLength,
        runningForMs: state.runningForMs,
        error: state.error,
        transcription: await loadTranscription(id),
    });
}

export async function POST(
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

        const userId = session.user.id;
        const { id } = await params;

        const body = await request
            .json()
            .catch(() => ({}) as Record<string, unknown>);
        const rawLanguage =
            typeof body.language === "string" ? body.language : null;
        const languageOverride =
            rawLanguage && ALLOWED_LANGUAGES.has(rawLanguage)
                ? rawLanguage
                : null;
        const force = body.force === true;

        if (!(await requireOwnedRecording(userId, id))) {
            return NextResponse.json(
                { error: "Recording not found" },
                { status: 404 },
            );
        }

        if (!force) {
            const existing = await loadTranscription(id);
            if (existing?.text) {
                // Don't error out and don't queue: return what's already there
                // so a client whose server-rendered snapshot went stale (the
                // transcription was written by a background job after the page
                // rendered) displays it instead of getting stuck on "No
                // transcription available".
                return NextResponse.json({
                    status: "idle",
                    transcription: existing.text,
                    detectedLanguage: existing.detectedLanguage,
                    costEstimate: existing.costEstimate,
                });
            }
        }

        // Check credentials up front. The queue would surface this too, but
        // only after a poll cycle — and it's the one failure the user can fix.
        const [credentials] = await db
            .select({ id: apiCredentials.id })
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, userId),
                    eq(apiCredentials.isDefaultTranscription, true),
                ),
            )
            .limit(1);

        if (!credentials) {
            return NextResponse.json(
                { error: "No transcription API configured" },
                { status: 400 },
            );
        }

        // Queue it and answer immediately. Transcribing an 80-minute recording
        // takes tens of minutes on this box; holding the request open for that
        // left the UI spinning with no way to tell a slow job from a dead one.
        const state = enqueueTranscription(userId, id, {
            languageOverride,
            force,
            // Someone is watching this one; it goes ahead of the auto-transcribe
            // backlog, which can be dozens of recordings deep.
            priority: true,
        });

        return NextResponse.json(
            {
                status: state.status,
                position: state.position,
                queueLength: state.queueLength,
            },
            { status: 202 },
        );
    } catch (error) {
        console.error("Error transcribing:", error);
        return NextResponse.json(
            { error: "Failed to transcribe recording" },
            { status: 500 },
        );
    }
}
