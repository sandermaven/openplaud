/**
 * The recording-title keywords that route a transcription to the "MT
 * transcripties" Notion database instead of the default "Master transcripties".
 * Matched as whole words, case-insensitively. English words only: the Dutch
 * "jaar" family ("voorjaarsoverleg", "najaarsaanbieding") must NOT match
 * "Yearly".
 */
export const MT_CADENCE_KEYWORDS = [
    "MT",
    "Monthly",
    "Quarterly",
    "Yearly",
    "Unbound",
] as const;

const MT_CADENCE_PATTERN = new RegExp(
    `\\b(?:${MT_CADENCE_KEYWORDS.join("|")})\\b`,
    "i",
);

/**
 * True when the recording title marks it as an MT-cadence meeting (MT,
 * Monthly, Quarterly, Yearly or Unbound) and the transcription should be
 * written to the "MT transcripties" database. Blank/missing titles route to
 * Master.
 */
export function isMtCadenceTitle(title: string | null | undefined): boolean {
    if (!title) return false;
    return MT_CADENCE_PATTERN.test(title);
}
