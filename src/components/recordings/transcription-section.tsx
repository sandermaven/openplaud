"use client";

import { LEDIndicator } from "@/components/led-indicator";
import { MetalButton } from "@/components/metal-button";
import { Panel } from "@/components/panel";
import { useTranscriptionJob } from "@/hooks/use-transcription-job";

interface TranscriptionSectionProps {
    recordingId: string;
    initialTranscription?: string;
    initialLanguage?: string | null;
    initialType?: string | null;
}

export function TranscriptionSection({
    recordingId,
    initialTranscription,
    initialLanguage,
    initialType,
}: TranscriptionSectionProps) {
    // Transcription is queued server-side; the hook polls for the result and
    // refreshes the route, which is what re-renders these props.
    const { isTranscribing, queuePosition, startTranscription } =
        useTranscriptionJob(recordingId);

    const transcription = initialTranscription;
    const detectedLanguage = initialLanguage;
    const transcriptionType = initialType;

    const handleTranscribe = () => {
        void startTranscription({ language: null, force: !!transcription });
    };

    return (
        <Panel>
            <div className="space-y-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-xl font-bold">Transcription</h2>
                        {detectedLanguage && (
                            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-panel-inset">
                                <LEDIndicator
                                    active
                                    status="active"
                                    size="sm"
                                />
                                <span className="text-label text-xs">
                                    Lang:{" "}
                                    <span className="font-mono uppercase text-accent-cyan">
                                        {detectedLanguage}
                                    </span>
                                </span>
                            </div>
                        )}
                        {transcriptionType && (
                            <span className="text-label text-xs px-3 py-1.5 rounded-lg bg-panel-inset border border-panel-border">
                                {transcriptionType}
                            </span>
                        )}
                    </div>
                    <MetalButton
                        onClick={handleTranscribe}
                        variant="cyan"
                        disabled={isTranscribing}
                        className="w-full md:w-auto"
                    >
                        {isTranscribing
                            ? queuePosition > 1
                                ? `In wachtrij (${queuePosition})`
                                : "Processing..."
                            : transcription
                              ? "Re-transcribe"
                              : "Transcribe"}
                    </MetalButton>
                </div>

                {transcription ? (
                    <div className="info-card">
                        <p className="whitespace-pre-wrap leading-relaxed">
                            {transcription}
                        </p>
                    </div>
                ) : (
                    <Panel variant="inset" className="text-center py-12">
                        <LEDIndicator
                            active={false}
                            status="active"
                            size="md"
                            className="mx-auto mb-4"
                        />
                        <p className="text-muted-foreground mb-2">
                            No transcription yet
                        </p>
                        <p className="text-sm text-text-muted">
                            Click "Transcribe" to generate a transcription
                        </p>
                    </Panel>
                )}
            </div>
        </Panel>
    );
}
