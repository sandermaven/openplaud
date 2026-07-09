"use client";

import {
    DollarSign,
    FileText,
    Languages,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import { useState } from "react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { Recording } from "@/types/recording";

interface Transcription {
    text?: string;
    detectedLanguage?: string;
    costEstimate?: number;
}

export interface TranscribeOptions {
    language: string | null;
    force: boolean;
}

interface TranscriptionPanelProps {
    recording: Recording;
    transcription?: Transcription;
    isTranscribing: boolean;
    onTranscribe: (options: TranscribeOptions) => void;
}

// "auto" maps to null (Whisper auto-detects); the rest are ISO-639-1 codes.
const LANGUAGE_OPTIONS = [
    { value: "auto", label: "Auto" },
    { value: "nl", label: "Nederlands" },
    { value: "en", label: "English" },
];

export function TranscriptionPanel({
    recording: _recording,
    transcription,
    isTranscribing,
    onTranscribe,
}: TranscriptionPanelProps) {
    const [language, setLanguage] = useState("auto");
    const [confirmOpen, setConfirmOpen] = useState(false);

    const hasTranscription = !!transcription?.text;

    const apiLanguage = () => (language === "auto" ? null : language);

    const handleClick = () => {
        if (hasTranscription) {
            // Re-transcribe overwrites, so confirm (and surface the cost) first.
            setConfirmOpen(true);
            return;
        }
        onTranscribe({ language: apiLanguage(), force: false });
    };

    const handleConfirm = () => {
        setConfirmOpen(false);
        onTranscribe({ language: apiLanguage(), force: true });
    };

    const costLabel =
        transcription?.costEstimate === undefined
            ? null
            : transcription.costEstimate === 0
              ? "Free"
              : `~$${transcription.costEstimate.toFixed(4)}`;

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <FileText className="w-5 h-5" />
                        Transcription
                    </CardTitle>
                    <div className="flex items-center gap-2">
                        <Select
                            value={language}
                            onValueChange={setLanguage}
                            disabled={isTranscribing}
                        >
                            <SelectTrigger className="h-8 w-[140px]" size="sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {LANGUAGE_OPTIONS.map((opt) => (
                                    <SelectItem
                                        key={opt.value}
                                        value={opt.value}
                                    >
                                        {opt.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button
                            onClick={handleClick}
                            size="sm"
                            disabled={isTranscribing}
                        >
                            {isTranscribing ? (
                                <>
                                    <Sparkles className="w-4 h-4 mr-2 animate-pulse" />
                                    Transcribing...
                                </>
                            ) : hasTranscription ? (
                                <>
                                    <RefreshCw className="w-4 h-4 mr-2" />
                                    Re-transcribe
                                </>
                            ) : (
                                <>
                                    <Sparkles className="w-4 h-4 mr-2" />
                                    Transcribe
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                {isTranscribing ? (
                    <div className="flex flex-col items-center justify-center py-12">
                        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mb-4" />
                        <p className="text-sm text-muted-foreground">
                            Transcribing audio...
                        </p>
                    </div>
                ) : transcription?.text ? (
                    <div className="space-y-4">
                        <div className="bg-muted rounded-lg p-4 max-h-96 overflow-y-auto">
                            <p className="text-sm whitespace-pre-wrap leading-relaxed">
                                {transcription.text}
                            </p>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t">
                            {transcription.detectedLanguage && (
                                <div className="flex items-center gap-1">
                                    <Languages className="w-3 h-3" />
                                    <span>
                                        Language:{" "}
                                        {transcription.detectedLanguage}
                                    </span>
                                </div>
                            )}
                            <div>
                                {transcription.text.split(/\s+/).length} words
                            </div>
                            <div>{transcription.text.length} characters</div>
                            {transcription.costEstimate !== undefined && (
                                <div className="flex items-center gap-1">
                                    <DollarSign className="w-3 h-3" />
                                    <span>
                                        Cost:{" "}
                                        {transcription.costEstimate === 0
                                            ? "Free"
                                            : `$${transcription.costEstimate.toFixed(4)}`}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                        <FileText className="w-12 h-12 text-muted-foreground mb-4" />
                        <p className="text-sm text-muted-foreground mb-4">
                            No transcription available
                        </p>
                        <Button onClick={handleClick} size="sm">
                            <Sparkles className="w-4 h-4 mr-2" />
                            Generate Transcription
                        </Button>
                    </div>
                )}
            </CardContent>

            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Transcriptie opnieuw genereren?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            Dit overschrijft de huidige transcriptie en kost
                            API-krediet
                            {costLabel ? ` (${costLabel})` : ""}. Doorgaan?
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Annuleren</AlertDialogCancel>
                        <AlertDialogAction onClick={handleConfirm}>
                            Opnieuw transcriberen
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Card>
    );
}
