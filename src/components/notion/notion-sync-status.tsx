"use client";

import {
    BookOpen,
    Check,
    ExternalLink,
    Loader2,
    RefreshCw,
    Settings,
    X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

export interface NotionSyncState {
    status?: string | null;
    pageUrl?: string | null;
    error?: string | null;
}

interface NotionSyncStatusProps {
    recordingId: string;
    /** Pass false to show a pointer to the settings instead of a sync button. */
    notionConfigured?: boolean;
    /** Server-rendered state; local state takes over once a sync runs here. */
    initialState?: NotionSyncState;
    /** Lets a list or dashboard refresh its own badge after a sync resolves. */
    onStateChange?: (recordingId: string, state: NotionSyncState) => void;
    className?: string;
}

/**
 * Notion sync status for one recording's transcription, with a retry button.
 * The sync itself runs server-side and out of band, so this polls
 * GET /api/recordings/:id/notion until it settles.
 */
export function NotionSyncStatus({
    recordingId,
    notionConfigured = true,
    initialState,
    onStateChange,
    className,
}: NotionSyncStatusProps) {
    const router = useRouter();
    // The dashboard keeps this component mounted while the selected recording
    // changes, so both pieces of local state are tagged with the recording they
    // belong to instead of being reset on every switch.
    const [override, setOverride] = useState<{
        recordingId: string;
        state: NotionSyncState;
    } | null>(null);
    const [syncingFor, setSyncingFor] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, []);

    useEffect(() => stopPolling, [stopPolling]);

    const applyState = useCallback(
        (next: NotionSyncState) => {
            setOverride({ recordingId, state: next });
            onStateChange?.(recordingId, next);
        },
        [onStateChange, recordingId],
    );

    const handleSync = useCallback(async () => {
        stopPolling();
        setSyncingFor(recordingId);
        applyState({ status: "syncing", pageUrl: null, error: null });

        const finish = () =>
            setSyncingFor((current) =>
                current === recordingId ? null : current,
            );

        try {
            const response = await fetch(
                `/api/recordings/${recordingId}/notion`,
                { method: "POST" },
            );

            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                const message = body.error || "Notion sync mislukt";
                toast.error(message);
                applyState({
                    status: "failed",
                    pageUrl: null,
                    error: body.error ?? null,
                });
                finish();
                return;
            }

            pollRef.current = setInterval(async () => {
                try {
                    const statusRes = await fetch(
                        `/api/recordings/${recordingId}/notion`,
                    );
                    if (!statusRes.ok) return;

                    const data = await statusRes.json();
                    const next: NotionSyncState = {
                        status: data.notionSyncStatus,
                        pageUrl: data.notionPageUrl,
                        error: data.notionSyncError,
                    };
                    applyState(next);

                    if (next.status === "synced" || next.status === "failed") {
                        stopPolling();
                        finish();
                        if (next.status === "synced") {
                            toast.success("Opgeslagen in Notion");
                        } else {
                            toast.error(next.error || "Notion sync mislukt");
                        }
                    }
                } catch {
                    stopPolling();
                    finish();
                }
            }, POLL_INTERVAL_MS);

            timeoutRef.current = setTimeout(() => {
                stopPolling();
                finish();
            }, POLL_TIMEOUT_MS);
        } catch {
            toast.error("Notion sync mislukt");
            applyState({ status: "failed", pageUrl: null, error: null });
            finish();
        }
    }, [applyState, recordingId, stopPolling]);

    if (!notionConfigured) {
        return (
            <div
                className={cn(
                    "flex items-center gap-2 text-sm text-muted-foreground",
                    className,
                )}
            >
                <Settings className="w-4 h-4 flex-shrink-0" />
                <span>
                    Notion niet geconfigureerd.{" "}
                    <button
                        type="button"
                        onClick={() => router.push("/dashboard#notion")}
                        className="text-primary underline hover:no-underline"
                    >
                        Configureer in instellingen
                    </button>
                </span>
            </div>
        );
    }

    const state =
        (override?.recordingId === recordingId ? override.state : null) ??
        initialState ??
        {};
    const status = state.status ?? null;
    const isBusy = syncingFor === recordingId || status === "syncing";

    return (
        <div
            className={cn(
                "flex flex-wrap items-center justify-between gap-2",
                className,
            )}
        >
            <div className="flex items-center gap-2 text-sm min-w-0">
                {isBusy ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground flex-shrink-0" />
                        <span className="text-muted-foreground">
                            Opslaan naar Notion...
                        </span>
                    </>
                ) : status === "synced" ? (
                    <>
                        <Check className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                        <span className="text-green-600 dark:text-green-400">
                            Opgeslagen in Notion
                        </span>
                    </>
                ) : status === "failed" ? (
                    <>
                        <X className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                        <span className="text-red-600 dark:text-red-400 break-words">
                            Notion sync mislukt
                            {state.error ? `: ${state.error}` : ""}
                        </span>
                    </>
                ) : (
                    <>
                        <BookOpen className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <span className="text-muted-foreground">
                            Nog niet opgeslagen in Notion
                        </span>
                    </>
                )}
            </div>

            <div className="flex items-center gap-2">
                {status === "synced" && state.pageUrl && (
                    <a
                        href={state.pageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline flex items-center gap-1"
                    >
                        Bekijk in Notion
                        <ExternalLink className="w-3 h-3" />
                    </a>
                )}
                <Button
                    variant={status === "synced" ? "ghost" : "outline"}
                    size="sm"
                    onClick={handleSync}
                    disabled={isBusy}
                >
                    {status === "synced" ? (
                        <>
                            <RefreshCw className="w-3 h-3" />
                            Opnieuw opslaan
                        </>
                    ) : status === "failed" ? (
                        <>
                            <RefreshCw className="w-3 h-3" />
                            Opnieuw proberen
                        </>
                    ) : (
                        <>
                            <BookOpen className="w-4 h-4" />
                            Opslaan in Notion
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}
