import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeRecording = vi.fn();

vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: (...args: unknown[]) => transcribeRecording(...args),
}));

import {
    enqueueTranscription,
    enqueueTranscriptions,
    getTranscriptionJobState,
    resetTranscriptionQueue,
} from "@/lib/transcription/queue";

/** A promise plus the handle to settle it, so a test can hold a job open. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Let the queue's microtask + pending promises run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Wait until nothing is queued or running for this recording. */
async function drain(recordingId: string) {
    for (let i = 0; i < 50; i++) {
        if (getTranscriptionJobState(recordingId).status === "idle") return;
        await tick();
    }
    throw new Error(`queue did not drain for ${recordingId}`);
}

const ok = { success: true, transcription: "text" };

describe("transcription queue", () => {
    beforeEach(() => {
        resetTranscriptionQueue();
        transcribeRecording.mockReset();
        transcribeRecording.mockResolvedValue(ok);
    });

    it("runs a queued job and reports idle afterwards", async () => {
        const state = enqueueTranscription("user-1", "rec-1");
        expect(state.status).toBe("queued");
        expect(state.position).toBe(1);

        await drain("rec-1");

        expect(transcribeRecording).toHaveBeenCalledTimes(1);
        expect(transcribeRecording).toHaveBeenCalledWith("user-1", "rec-1", {});
    });

    it("does not queue the same recording twice", async () => {
        const first = deferred<typeof ok>();
        transcribeRecording.mockReturnValueOnce(first.promise);

        enqueueTranscription("user-1", "rec-1");
        enqueueTranscription("user-1", "rec-2");
        // A second sync reporting the same backlog must not stack duplicates.
        enqueueTranscription("user-1", "rec-2");
        enqueueTranscription("user-1", "rec-2");

        await tick();

        expect(getTranscriptionJobState("rec-1").status).toBe("running");
        expect(getTranscriptionJobState("rec-2")).toMatchObject({
            status: "queued",
            position: 1,
            queueLength: 2,
        });

        first.resolve(ok);
        await drain("rec-2");

        expect(transcribeRecording).toHaveBeenCalledTimes(2);
    });

    it("counts only recordings it actually added", () => {
        const held = deferred<typeof ok>();
        transcribeRecording.mockReturnValue(held.promise);

        expect(enqueueTranscriptions("user-1", ["a", "b", "c"])).toBe(3);
        expect(enqueueTranscriptions("user-1", ["a", "b", "c"])).toBe(0);

        held.resolve(ok);
    });

    it("merges a forced re-transcribe into a pending auto run", async () => {
        const first = deferred<typeof ok>();
        transcribeRecording.mockReturnValueOnce(first.promise);

        enqueueTranscription("user-1", "busy");
        enqueueTranscription("user-1", "rec-1");
        // Auto-transcribe queued it without a language; the user then asks for
        // a forced Dutch re-run. The forced request must win, not be dropped.
        enqueueTranscription("user-1", "rec-1", {
            force: true,
            languageOverride: "nl",
        });

        await tick();
        first.resolve(ok);
        await drain("rec-1");

        expect(transcribeRecording).toHaveBeenCalledWith("user-1", "rec-1", {
            force: true,
            languageOverride: "nl",
        });
        expect(transcribeRecording).toHaveBeenCalledTimes(2);
    });

    it("queues a forced re-run behind a non-forced job that is already running", async () => {
        const running = deferred<typeof ok>();
        transcribeRecording.mockReturnValueOnce(running.promise);

        enqueueTranscription("user-1", "rec-1");
        await tick();
        expect(getTranscriptionJobState("rec-1").status).toBe("running");

        enqueueTranscription("user-1", "rec-1", { force: true });
        running.resolve(ok);
        await drain("rec-1");

        expect(transcribeRecording).toHaveBeenNthCalledWith(
            2,
            "user-1",
            "rec-1",
            expect.objectContaining({ force: true }),
        );
    });

    it("puts a user-triggered job ahead of the auto-transcribe backlog", async () => {
        const running = deferred<typeof ok>();
        transcribeRecording.mockReturnValueOnce(running.promise);

        // A sync queues a backlog, then the user clicks Re-transcribe.
        enqueueTranscriptions("user-1", ["busy", "bg-1", "bg-2", "bg-3"]);
        await tick();
        enqueueTranscription("user-1", "mine", {
            force: true,
            priority: true,
        });

        expect(getTranscriptionJobState("mine").position).toBe(1);
        expect(getTranscriptionJobState("bg-1").position).toBe(2);

        running.resolve(ok);
        await drain("mine");

        expect(transcribeRecording).toHaveBeenNthCalledWith(
            2,
            "user-1",
            "mine",
            expect.objectContaining({ force: true }),
        );
    });

    it("promotes a queued background job when the user asks for it", async () => {
        const running = deferred<typeof ok>();
        transcribeRecording.mockReturnValueOnce(running.promise);

        enqueueTranscriptions("user-1", ["busy", "bg-1", "bg-2", "mine"]);
        await tick();
        expect(getTranscriptionJobState("mine").position).toBe(3);

        enqueueTranscription("user-1", "mine", { priority: true });
        expect(getTranscriptionJobState("mine").position).toBe(1);
        expect(getTranscriptionJobState("bg-1").position).toBe(2);

        running.resolve(ok);
        await drain("mine");
    });

    it("keeps draining after a job fails and reports the error once", async () => {
        transcribeRecording
            .mockResolvedValueOnce({ success: false, error: "Whisper is down" })
            .mockResolvedValueOnce(ok);

        enqueueTranscription("user-1", "rec-1");
        enqueueTranscription("user-1", "rec-2");

        await drain("rec-2");

        const failed = getTranscriptionJobState("rec-1");
        expect(failed.status).toBe("idle");
        expect(failed.error).toBe("Whisper is down");
        expect(transcribeRecording).toHaveBeenCalledTimes(2);
    });

    it("survives a job that throws", async () => {
        transcribeRecording
            .mockRejectedValueOnce(new Error("ffmpeg exploded"))
            .mockResolvedValueOnce(ok);

        enqueueTranscription("user-1", "rec-1");
        enqueueTranscription("user-1", "rec-2");

        await drain("rec-2");

        expect(getTranscriptionJobState("rec-1").error).toBe("ffmpeg exploded");
        expect(transcribeRecording).toHaveBeenCalledTimes(2);
    });
});
