import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { transcribeRecording } from "@/lib/transcription/transcribe-recording";

// Whisper only gets a forced language for the options the UI offers. Anything
// else (including "auto") means auto-detect.
const ALLOWED_LANGUAGES = new Set(["nl", "en"]);

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

        const result = await transcribeRecording(session.user.id, id, {
            languageOverride,
            force,
        });

        // A transcription already exists and the caller didn't ask to overwrite.
        if (result.alreadyExists) {
            return NextResponse.json(
                {
                    error: "Transcription already exists. Retry with force to overwrite.",
                },
                { status: 409 },
            );
        }

        if (!result.success) {
            const error = result.error ?? "Failed to transcribe recording";
            if (error === "Recording not found") {
                return NextResponse.json({ error }, { status: 404 });
            }
            if (error === "No transcription API configured") {
                return NextResponse.json({ error }, { status: 400 });
            }
            return NextResponse.json(
                { error: "Failed to transcribe recording" },
                { status: 500 },
            );
        }

        return NextResponse.json({
            transcription: result.transcription,
            detectedLanguage: result.detectedLanguage,
            costEstimate: result.costEstimate,
        });
    } catch (error) {
        console.error("Error transcribing:", error);
        return NextResponse.json(
            { error: "Failed to transcribe recording" },
            { status: 500 },
        );
    }
}
