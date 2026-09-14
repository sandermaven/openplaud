"use client";

import { ArrowLeft, BookOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { RecordingPlayer } from "@/components/dashboard/recording-player";
import {
    type TranscribeOptions,
    TranscriptionPanel,
} from "@/components/dashboard/transcription-panel";
import { NotionSyncStatus } from "@/components/notion/notion-sync-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Recording } from "@/types/recording";

interface Transcription {
    text?: string;
    detectedLanguage?: string;
    transcriptionType?: string;
    costEstimate?: number;
}

interface RecordingWorkstationProps {
    recording: Recording;
    transcription?: Transcription;
    notionSyncStatus?: string | null;
    notionPageUrl?: string | null;
    notionSyncError?: string | null;
    notionConfigured?: boolean;
}

export function RecordingWorkstation({
    recording,
    transcription,
    notionSyncStatus,
    notionPageUrl,
    notionSyncError,
    notionConfigured = false,
}: RecordingWorkstationProps) {
    const router = useRouter();
    const [isTranscribing, setIsTranscribing] = useState(false);

    const handleTranscribe = useCallback(
        async ({ language, force }: TranscribeOptions) => {
            setIsTranscribing(true);
            try {
                const response = await fetch(
                    `/api/recordings/${recording.id}/transcribe`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ language, force }),
                    },
                );

                if (response.ok) {
                    toast.success(
                        force
                            ? "Transcriptie opnieuw gegenereerd"
                            : "Transcription complete",
                    );
                    router.refresh();
                } else {
                    const error = await response.json().catch(() => ({}));
                    toast.error(error.error || "Transcription failed");
                }
            } catch {
                toast.error("Failed to transcribe recording");
            } finally {
                setIsTranscribing(false);
            }
        },
        [recording.id, router],
    );

    return (
        <div className="bg-background">
            <div className="container mx-auto px-4 py-6 max-w-4xl">
                {/* Header */}
                <div className="flex items-center gap-4 mb-6">
                    <Button
                        onClick={() => router.push("/dashboard")}
                        variant="outline"
                        size="icon"
                    >
                        <ArrowLeft className="w-4 h-4" />
                    </Button>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-3xl font-bold truncate">
                            {recording.filename}
                        </h1>
                        <p className="text-muted-foreground text-sm mt-1">
                            {new Date(recording.startTime).toLocaleString()}
                        </p>
                    </div>
                </div>

                {/* Content */}
                <div className="space-y-6">
                    <RecordingPlayer recording={recording} />
                    <TranscriptionPanel
                        recording={recording}
                        transcription={transcription}
                        isTranscribing={isTranscribing}
                        onTranscribe={handleTranscribe}
                    />

                    {/* Metadata */}
                    <Card>
                        <CardHeader>
                            <CardTitle>Details</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        Duration
                                    </div>
                                    <div className="font-medium">
                                        {Math.floor(recording.duration / 60000)}
                                        :
                                        {((recording.duration % 60000) / 1000)
                                            .toFixed(0)
                                            .padStart(2, "0")}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        File Size
                                    </div>
                                    <div className="font-medium">
                                        {(
                                            recording.filesize /
                                            (1024 * 1024)
                                        ).toFixed(2)}{" "}
                                        MB
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        Device
                                    </div>
                                    <div className="font-mono text-xs truncate">
                                        {recording.deviceSn}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-muted-foreground text-xs mb-1">
                                        Date
                                    </div>
                                    <div className="font-medium">
                                        {new Date(
                                            recording.startTime,
                                        ).toLocaleDateString()}
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Notion Sync */}
                    {transcription?.text && (
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <BookOpen className="w-4 h-4" />
                                    Notion
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <NotionSyncStatus
                                    recordingId={recording.id}
                                    notionConfigured={notionConfigured}
                                    initialState={{
                                        status: notionSyncStatus,
                                        pageUrl: notionPageUrl,
                                        error: notionSyncError,
                                    }}
                                />
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
