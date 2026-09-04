import { describe, expect, it } from "vitest";
import { toMp3Name } from "@/lib/transcription/compress-audio";

describe("toMp3Name", () => {
    it("appends the extension when the recording title has none", () => {
        // Auto-generated titles overwrite recordings.filename, so by the time a
        // re-transcribe runs the "filename" is a title with no extension. It
        // used to reach Whisper as-is, which rejects the upload with
        // "Invalid file format".
        expect(toMp3Name("Viaje en Moto por Tirana")).toBe(
            "Viaje_en_Moto_por_Tirana.mp3",
        );
    });

    it("replaces an existing extension", () => {
        expect(toMp3Name("recording.opus")).toBe("recording.mp3");
    });

    it("strips characters that would escape the temp directory", () => {
        expect(toMp3Name("../../etc/passwd")).not.toContain("/");
        expect(toMp3Name("../../etc/passwd")).toMatch(/\.mp3$/);
    });

    it("adds a chunk suffix before the extension", () => {
        expect(toMp3Name("Gesprek met Jan", "_part2")).toBe(
            "Gesprek_met_Jan_part2.mp3",
        );
    });

    it("falls back to a usable name when nothing survives sanitising", () => {
        expect(toMp3Name("///")).toBe("audio.mp3");
    });
});
