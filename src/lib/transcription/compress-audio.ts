import { execFile } from "node:child_process";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WHISPER_MAX_SIZE = 24 * 1024 * 1024; // 24MB (leave 1MB headroom under 25MB limit)

/**
 * Compress audio buffer to fit within Whisper's 25MB upload limit.
 * Converts to MP3 at a reduced bitrate using ffmpeg.
 * Also fixes format issues (e.g. OPUS files that Whisper doesn't accept).
 *
 * Returns the original buffer unchanged if it's already small enough and in a supported format.
 */
export async function compressAudioForTranscription(
    audioBuffer: Buffer,
    filename: string,
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const isOversized = audioBuffer.length > WHISPER_MAX_SIZE;
    const hasUnsupportedExt =
        !filename.match(/\.(mp3|m4a|mp4|mpeg|mpga|wav|webm|flac|ogg|oga)$/i);

    if (!isOversized && !hasUnsupportedExt) {
        const contentType = filename.endsWith(".mp3")
            ? "audio/mpeg"
            : "audio/opus";
        return { buffer: audioBuffer, filename, contentType };
    }

    const tempDir = await mkdtemp(join(tmpdir(), "openplaud-compress-"));
    const inputPath = join(tempDir, `input_${filename}`);
    const outputFilename = filename.replace(/\.[^.]+$/, ".mp3");
    const outputPath = join(tempDir, `output_${outputFilename}`);

    try {
        await writeFile(inputPath, audioBuffer);

        // Calculate target bitrate based on file size
        // For a file just over 25MB, 64kbps is usually enough
        // For larger files, use lower bitrate
        const targetBitrate = isOversized ? "48k" : "64k";

        await execFileAsync("ffmpeg", [
            "-i",
            inputPath,
            "-vn", // no video
            "-ac",
            "1", // mono (halves size, fine for speech)
            "-ar",
            "16000", // 16kHz sample rate (optimal for Whisper)
            "-b:a",
            targetBitrate,
            "-f",
            "mp3",
            outputPath,
        ]);

        const compressedBuffer = await readFile(outputPath);

        console.log(
            `[compress-audio] ${filename}: ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB → ${(compressedBuffer.length / 1024 / 1024).toFixed(1)}MB (${targetBitrate} mono)`,
        );

        return {
            buffer: compressedBuffer,
            filename: outputFilename,
            contentType: "audio/mpeg",
        };
    } finally {
        // Clean up temp files
        await unlink(inputPath).catch(() => {});
        await unlink(outputPath).catch(() => {});
    }
}
