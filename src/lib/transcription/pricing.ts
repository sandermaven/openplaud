// Transcription pricing per minute (USD) for known models/providers.
// These are best-effort estimates based on published pricing.
// Unknown models default to null (no cost shown).

const PRICE_PER_MINUTE: Record<string, number> = {
    // OpenAI
    "whisper-1": 0.006,
    // Groq (free tier)
    "whisper-large-v3": 0,
    "whisper-large-v3-turbo": 0,
    "distil-whisper-large-v3-en": 0,
    // GPT-4o audio models
    "gpt-4o-transcribe": 0.006,
    "gpt-4o-mini-transcribe": 0.003,
};

// Provider-level overrides (some providers are always free)
const FREE_PROVIDERS = new Set(["browser", "groq"]);

/**
 * Estimate transcription cost based on provider, model, and audio duration.
 * Returns cost in USD, or null if pricing is unknown.
 */
export function estimateTranscriptionCost(
    provider: string,
    model: string,
    durationMs: number,
): number | null {
    if (FREE_PROVIDERS.has(provider.toLowerCase())) {
        return 0;
    }

    const pricePerMinute = PRICE_PER_MINUTE[model];
    if (pricePerMinute === undefined) {
        return null;
    }

    const durationMinutes = durationMs / 60000;
    return Math.round(durationMinutes * pricePerMinute * 1000000) / 1000000; // 6 decimal precision
}
