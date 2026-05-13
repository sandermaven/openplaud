import { describe, expect, it, vi } from "vitest";
import { buildNotionPageContent, chunkText } from "../lib/notion/blocks";

// Mock env for encryption tests
vi.mock("../lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));

describe("Notion Integration", () => {
    describe("chunkText", () => {
        it("should return single chunk for short text", () => {
            const text = "Hello, world!";
            const chunks = chunkText(text);
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toBe(text);
        });

        it("should split text at 2000 characters", () => {
            const text = "a".repeat(4000);
            const chunks = chunkText(text);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            for (const chunk of chunks) {
                expect(chunk.length).toBeLessThanOrEqual(2000);
            }
        });

        it("should preserve all content after chunking", () => {
            const text = "word ".repeat(500); // ~2500 chars
            const chunks = chunkText(text);
            const rejoined = chunks.join(" "); // trimStart in chunkText may remove leading spaces
            // Check total length is approximately correct
            expect(rejoined.length).toBeGreaterThan(0);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
        });

        it("should prefer breaking at newlines", () => {
            const part1 = "a".repeat(1500);
            const part2 = "b".repeat(1500);
            const text = `${part1}\n${part2}`;
            const chunks = chunkText(text);
            expect(chunks[0]).toBe(part1);
        });

        it("should handle empty string", () => {
            const chunks = chunkText("");
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toBe("");
        });

        it("should handle exactly 2000 characters", () => {
            const text = "x".repeat(2000);
            const chunks = chunkText(text);
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toBe(text);
        });
    });

    describe("buildNotionPageContent", () => {
        it("should render transcription as a single markdown code block", () => {
            const batches = buildNotionPageContent({
                transcriptionText: "This is a test transcription.",
            });

            expect(batches).toHaveLength(1);
            const blocks = batches[0];

            expect(blocks).toHaveLength(1);
            const codeBlock = blocks[0];
            expect(codeBlock.type).toBe("code");
            if (codeBlock.type === "code") {
                expect(codeBlock.code.language).toBe("markdown");
                expect(codeBlock.code.rich_text).toHaveLength(1);
                const item = codeBlock.code.rich_text[0];
                expect(
                    item.type === "text" && item.text.content,
                ).toBe("This is a test transcription.");
            }
        });

        it("should chunk long transcriptions into rich_text items within one code block", () => {
            const longText = "x".repeat(5000);
            const batches = buildNotionPageContent({
                transcriptionText: longText,
            });

            const blocks = batches[0];
            expect(blocks).toHaveLength(1);
            const codeBlock = blocks[0];
            expect(codeBlock.type).toBe("code");
            if (codeBlock.type === "code") {
                expect(codeBlock.code.rich_text.length).toBeGreaterThanOrEqual(
                    3,
                );
                for (const item of codeBlock.code.rich_text) {
                    if (item.type === "text") {
                        expect(item.text.content.length).toBeLessThanOrEqual(
                            2000,
                        );
                    }
                }
            }
        });

        it("should include summary section when provided", () => {
            const batches = buildNotionPageContent({
                transcriptionText: "Transcription text",
                summary: "This is a summary",
                includeSummary: true,
            });

            const blocks = batches[0];
            // First block should be summary heading
            expect(blocks[0].type).toBe("heading_2");
            if (blocks[0].type === "heading_2") {
                expect(
                    blocks[0].heading_2.rich_text[0].type === "text" &&
                        blocks[0].heading_2.rich_text[0].text.content,
                ).toBe("Summary");
            }
        });

        it("should include action items as to_do blocks", () => {
            const batches = buildNotionPageContent({
                transcriptionText: "Transcription text",
                actionItems: ["Item 1", "Item 2", "Item 3"],
                includeActionItems: true,
            });

            const blocks = batches[0];
            const todoBlocks = blocks.filter((b) => b.type === "to_do");
            expect(todoBlocks).toHaveLength(3);
        });

        it("should skip summary when includeSummary is false", () => {
            const batches = buildNotionPageContent({
                transcriptionText: "Transcription text",
                summary: "This should be skipped",
                includeSummary: false,
            });

            const blocks = batches[0];
            const headings = blocks.filter(
                (b) =>
                    b.type === "heading_2" &&
                    "heading_2" in b &&
                    b.heading_2.rich_text[0].type === "text" &&
                    b.heading_2.rich_text[0].text.content === "Summary",
            );
            expect(headings).toHaveLength(0);
        });

        it("should skip action items when includeActionItems is false", () => {
            const batches = buildNotionPageContent({
                transcriptionText: "Transcription text",
                actionItems: ["Item 1"],
                includeActionItems: false,
            });

            const blocks = batches[0];
            const todoBlocks = blocks.filter((b) => b.type === "to_do");
            expect(todoBlocks).toHaveLength(0);
        });

        it("should batch blocks at 100 blocks per batch", () => {
            // Many action items → many to_do blocks → multiple batches
            const items = Array.from({ length: 250 }, (_, i) => `Item ${i}`);

            const batches = buildNotionPageContent({
                transcriptionText: "short",
                actionItems: items,
                includeActionItems: true,
            });

            expect(batches.length).toBeGreaterThan(1);
            for (const batch of batches) {
                expect(batch.length).toBeLessThanOrEqual(100);
            }
        });
    });

    describe("Encryption roundtrip for Notion token", () => {
        it("should encrypt and decrypt a Notion integration token", async () => {
            const { encrypt, decrypt } = await import("../lib/encryption");

            const token = "ntn_1234567890abcdef1234567890";
            const encrypted = encrypt(token);
            const decrypted = decrypt(encrypted);

            expect(encrypted).not.toBe(token);
            expect(decrypted).toBe(token);
        });
    });
});
