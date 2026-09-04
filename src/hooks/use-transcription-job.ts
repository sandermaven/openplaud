"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** How often to ask the server what the transcription queue is doing. */
const POLL_INTERVAL_MS = 5000;
/** Give up polling after this many consecutive failed status checks. */
const MAX_POLL_FAILURES = 5;

export interface StartTranscriptionOptions {
    language: string | null;
    force: boolean;
}

/**
 * Drives one recording's transcription against the server-side queue.
 *
 * `POST /api/recordings/[id]/transcribe` answers 202 without waiting — an
 * 80-minute recording takes tens of minutes to transcribe on this box — so the
 * only way to know how it ends is to poll `GET` on the same route. Polling also
 * means a reload adopts a job that is already running instead of showing an idle
 * button while the server is still working.
 */
export function useTranscriptionJob(recordingId: string | null | undefined) {
    const router = useRouter();
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [queuePosition, setQueuePosition] = useState(0);

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const failuresRef = useRef(0);

    const stopPolling = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const poll = useCallback(
        async (id: string) => {
            try {
                const res = await fetch(`/api/recordings/${id}/transcribe`);
                if (!res.ok) throw new Error("status check failed");
                const data = await res.json();
                failuresRef.current = 0;

                if (data.status === "idle") {
                    setIsTranscribing(false);
                    setQueuePosition(0);
                    if (data.error) {
                        toast.error(data.error);
                    } else if (data.transcription?.text) {
                        toast.success("Transcriptie klaar");
                    }
                    router.refresh();
                    return;
                }

                setQueuePosition(
                    data.status === "queued" ? (data.position ?? 0) : 0,
                );
            } catch {
                failuresRef.current += 1;
                if (failuresRef.current >= MAX_POLL_FAILURES) {
                    setIsTranscribing(false);
                    setQueuePosition(0);
                    toast.error(
                        "Kan de transcriptiestatus niet ophalen. Ververs de pagina.",
                    );
                    return;
                }
            }

            timerRef.current = setTimeout(() => poll(id), POLL_INTERVAL_MS);
        },
        [router],
    );

    // Pick up whatever the server is already doing with this recording.
    useEffect(() => {
        stopPolling();
        setIsTranscribing(false);
        setQueuePosition(0);
        failuresRef.current = 0;
        if (!recordingId) return;

        let cancelled = false;
        fetch(`/api/recordings/${recordingId}/transcribe`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (cancelled || !data || data.status === "idle") return;
                setIsTranscribing(true);
                setQueuePosition(
                    data.status === "queued" ? (data.position ?? 0) : 0,
                );
                timerRef.current = setTimeout(
                    () => poll(recordingId),
                    POLL_INTERVAL_MS,
                );
            })
            .catch(() => {});

        return () => {
            cancelled = true;
            stopPolling();
        };
    }, [recordingId, poll, stopPolling]);

    const startTranscription = useCallback(
        async ({ language, force }: StartTranscriptionOptions) => {
            if (!recordingId) return;

            stopPolling();
            failuresRef.current = 0;
            setIsTranscribing(true);
            setQueuePosition(0);

            try {
                const response = await fetch(
                    `/api/recordings/${recordingId}/transcribe`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ language, force }),
                    },
                );
                const data = await response.json().catch(() => ({}));

                if (!response.ok) {
                    setIsTranscribing(false);
                    toast.error(data.error || "Transcription failed");
                    return;
                }

                if (data.status === "idle") {
                    // A transcription already existed; nothing was queued.
                    setIsTranscribing(false);
                    router.refresh();
                    return;
                }

                setQueuePosition(
                    data.status === "queued" ? (data.position ?? 0) : 0,
                );
                toast.success(
                    data.status === "queued" && data.position > 1
                        ? `In de wachtrij gezet (plek ${data.position})`
                        : "Transcriptie gestart",
                );
                timerRef.current = setTimeout(
                    () => poll(recordingId),
                    POLL_INTERVAL_MS,
                );
            } catch {
                setIsTranscribing(false);
                toast.error("Failed to transcribe recording");
            }
        },
        [recordingId, router, poll, stopPolling],
    );

    return { isTranscribing, queuePosition, startTranscription };
}
