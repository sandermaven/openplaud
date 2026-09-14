import { desc, eq } from "drizzle-orm";
import { Workstation } from "@/components/dashboard/workstation";
import type { NotionSyncState } from "@/components/notion/notion-sync-status";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";
import { getNotionConfig } from "@/lib/notion/config";
import { serializeRecording } from "@/types/recording";

export default async function DashboardPage() {
    const session = await requireAuth();

    const userRecordings = await db
        .select({
            id: recordings.id,
            filename: recordings.filename,
            duration: recordings.duration,
            startTime: recordings.startTime,
            filesize: recordings.filesize,
            deviceSn: recordings.deviceSn,
        })
        .from(recordings)
        .where(eq(recordings.userId, session.user.id))
        .orderBy(desc(recordings.startTime));

    const userTranscriptions = await db
        .select({
            recordingId: transcriptions.recordingId,
            text: transcriptions.text,
            language: transcriptions.detectedLanguage,
            notionSyncStatus: transcriptions.notionSyncStatus,
            notionPageUrl: transcriptions.notionPageUrl,
            notionSyncError: transcriptions.notionSyncError,
            costEstimate: transcriptions.costEstimate,
        })
        .from(transcriptions)
        .where(eq(transcriptions.userId, session.user.id));

    const recordingsData = userRecordings.map(serializeRecording);

    const transcriptionMap = new Map(
        userTranscriptions.map((t) => [
            t.recordingId,
            {
                text: t.text,
                language: t.language || undefined,
                costEstimate: t.costEstimate ?? undefined,
            },
        ]),
    );

    const notionStates = new Map<string, NotionSyncState>(
        userTranscriptions.map((t) => [
            t.recordingId,
            {
                status: t.notionSyncStatus,
                pageUrl: t.notionPageUrl,
                error: t.notionSyncError,
            },
        ]),
    );

    // Resolved server-side (DB → env fallback) so the panel doesn't flash
    // "not configured" while a client fetch is in flight.
    const notionCfg = await getNotionConfig(session.user.id);

    return (
        <Workstation
            recordings={recordingsData}
            transcriptions={transcriptionMap}
            notionStates={notionStates}
            notionConfigured={!!notionCfg?.enabled}
        />
    );
}
