import { execFile } from "node:child_process";
import {
    mkdtemp,
    readFile,
    readdir,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WHISPER_MAX_SIZE = 24 * 1024 * 1024; // 24MB (leave 1MB headroom under 25MB limit)
const CHUNK_DURATION_SECS = 1800; // 30 minutes per chunk

export type AudioChunk = {
    buffer: Buffer;
    filename: string;
    contentType: string;
};

/**
 * Get audio duration in seconds using ffprobe.
 */
async function getAudioDuration(filePath: string): Promise<number> {
    const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "quiet",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        filePath,
    ]);
    return parseFloat(stdout.trim());
}

/**
 * Split and compress audio into chunks that fit within Whisper's size limit.
 */
async function splitAndCompressAudio(
    inputPath: string,
    tempDir: string,
    filename: string,
    duration: number,
): Promise<AudioChunk[]> {
    const chunkCount = Math.ceil(duration / CHUNK_DURATION_SECS);
    const outputBase = filename.replace(/\.[^.]+$/, "");
    const chunks: AudioChunk[] = [];

    console.log(
        `[compress-audio] ${filename}: splitting into ${chunkCount} chunks (${Math.round(duration / 60)}min total)`,
    );

    for (let i = 0; i < chunkCount; i++) {
        const offset = i * CHUNK_DURATION_SECS;
        const chunkFilename = `${outputBase}_part${i + 1}.mp3`;
        const outputPath = join(tempDir, chunkFilename);

        await execFileAsync("ffmpeg", [
            "-ss",
            String(offset),
            "-i",
            inputPath,
            "-t",
            String(CHUNK_DURATION_SECS),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "48k",
            "-f",
            "mp3",
            outputPath,
        ]);

        const buffer = await readFile(outputPath);
        console.log(
            `[compress-audio]   chunk ${i + 1}/${chunkCount}: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`,
        );

        chunks.push({
            buffer,
            filename: chunkFilename,
            contentType: "audio/mpeg",
        });
    }

    return chunks;
}

/**
 * Compress audio buffer to fit within Whisper's 25MB upload limit.
 * Converts to MP3 at a reduced bitrate using ffmpeg.
 * Also fixes format issues (e.g. OPUS files that Whisper doesn't accept).
 *
 * For files that still exceed the limit after compression, splits into
 * 30-minute chunks that are each compressed individually.
 *
 * Returns an array of audio chunks (usually one, multiple for long recordings).
 */
export async function compressAudioForTranscription(
    audioBuffer: Buffer,
    filename: string,
): Promise<AudioChunk[]> {
    const isOversized = audioBuffer.length > WHISPER_MAX_SIZE;
    const hasUnsupportedExt =
        !filename.match(/\.(mp3|m4a|mp4|mpeg|mpga|wav|webm|flac|ogg|oga)$/i);

    if (!isOversized && !hasUnsupportedExt) {
        const contentType = filename.endsWith(".mp3")
            ? "audio/mpeg"
            : "audio/opus";
        return [{ buffer: audioBuffer, filename, contentType }];
    }

    const tempDir = await mkdtemp(join(tmpdir(), "openplaud-compress-"));
    const inputPath = join(tempDir, `input_${filename}`);
    const outputFilename = filename.replace(/\.[^.]+$/, ".mp3");
    const outputPath = join(tempDir, `output_${outputFilename}`);

    try {
        await writeFile(inputPath, audioBuffer);

        const targetBitrate = isOversized ? "48k" : "64k";

        await execFileAsync("ffmpeg", [
            "-i",
            inputPath,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
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

        // If compressed file fits, return as single chunk
        if (compressedBuffer.length <= WHISPER_MAX_SIZE) {
            return [
                {
                    buffer: compressedBuffer,
                    filename: outputFilename,
                    contentType: "audio/mpeg",
                },
            ];
        }

        // Still too large — split into 30-minute chunks
        const duration = await getAudioDuration(inputPath);
        return await splitAndCompressAudio(
            inputPath,
            tempDir,
            filename,
            duration,
        );
    } finally {
        // Clean up all temp files
        const files = await readdir(tempDir).catch(() => []);
        await Promise.all(
            files.map((f) => unlink(join(tempDir, f)).catch(() => {})),
        );
    }
}
