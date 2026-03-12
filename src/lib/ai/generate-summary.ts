import { and, eq } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import { decrypt } from "@/lib/encryption";

const DEFAULT_SUMMARY_PROMPT = `Vat deze transcriptie samen in de volgende structuur:

**Kern** (1-2 zinnen: waar ging het over?)
**Beslissingen** (wat is er besloten?)
**Actiepunten** (wie doet wat, eventueel met deadline)
**Opvallend** (context, spanningen, open vragen — alleen als relevant)

Wees bondig. Laat secties weg als ze leeg zijn.`;

export { DEFAULT_SUMMARY_PROMPT };

export async function generateSummaryFromTranscription(
    userId: string,
    transcriptionText: string,
    customPrompt?: string | null,
): Promise<string | null> {
    try {
        // Get user's AI credentials (prefer enhancement provider, fallback to transcription)
        const [enhancementCredentials] = await db
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, userId),
                    eq(apiCredentials.isDefaultEnhancement, true),
                ),
            )
            .limit(1);

        const [transcriptionCredentials] = await db
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.userId, userId),
                    eq(apiCredentials.isDefaultTranscription, true),
                ),
            )
            .limit(1);

        const credentials = enhancementCredentials || transcriptionCredentials;

        if (!credentials) {
            console.warn("No AI provider found for summary generation");
            return null;
        }

        const apiKey = decrypt(credentials.apiKey);

        const openai = new OpenAI({
            apiKey,
            baseURL: credentials.baseUrl || undefined,
        });

        let model = credentials.defaultModel || "gpt-4o-mini";
        if (model.includes("whisper")) {
            model = "gpt-4o-mini";
        }

        const prompt = customPrompt || DEFAULT_SUMMARY_PROMPT;

        const response = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: "user",
                    content: `${prompt}\n\n---\n\n${transcriptionText}`,
                },
            ],
            temperature: 0.3,
        });

        return response.choices[0]?.message?.content?.trim() || null;
    } catch (error) {
        console.error("Error generating summary:", error);
        return null;
    }
}
