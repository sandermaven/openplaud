/**
 * Where a transcription gets written in Notion, and the property shape that
 * database expects. The two live databases differ in a handful of property
 * names/values; everything else (Bron, Duration, Recorded, Language, the page
 * body) is identical. See the data-source schemas captured in the plan.
 */

/** "MT transcripties" database id. Overridable via env NOTION_MT_DATABASE_ID. */
export const DEFAULT_MT_DATABASE_ID = "7a5cd371-de2b-475d-86be-44ed32f2c6dc";

export interface NotionWriteTarget {
    databaseId: string;
    /** Title property name: "Name" (Master) vs "Titel" (MT). */
    titleProperty: string;
    /** Value for the "Type" select, or null to omit Type entirely (MT). */
    typeSelect: string | null;
    /** Status-type property name: "Status" (Master) vs "Status 1" (MT). */
    statusProperty: string;
    /** Value for the status-type property, e.g. "Inbox". */
    statusValue: string;
    /** Extra select property name (MT's "Status"), or null to omit. */
    selectStatusProperty: string | null;
    /** Value for the extra select, e.g. "Getranscribeerd". */
    selectStatusValue: string | null;
}

/** Default "Master transcripties" write target (unchanged behaviour). */
export function masterTarget(databaseId: string): NotionWriteTarget {
    return {
        databaseId,
        titleProperty: "Name",
        typeSelect: "Transcript",
        statusProperty: "Status",
        statusValue: "Inbox",
        selectStatusProperty: null,
        selectStatusValue: null,
    };
}

/** "MT transcripties" write target for MT-cadence recordings. */
export function mtTarget(databaseId: string): NotionWriteTarget {
    return {
        databaseId,
        titleProperty: "Titel",
        typeSelect: null,
        statusProperty: "Status 1",
        statusValue: "Inbox",
        selectStatusProperty: "Status",
        selectStatusValue: "Getranscribeerd",
    };
}

interface TranscriptionPropertyInput {
    pageTitle: string;
    durationText: string;
    startTimeIso: string;
    detectedLanguage: string | null;
}

/**
 * Build the Notion page properties for a transcription, shaped for the given
 * target database.
 */
export function buildTranscriptionProperties(
    target: NotionWriteTarget,
    input: TranscriptionPropertyInput,
): Record<string, unknown> {
    const properties: Record<string, unknown> = {
        [target.titleProperty]: {
            title: [{ text: { content: input.pageTitle } }],
        },
        Bron: {
            select: { name: "Plaud" },
        },
        [target.statusProperty]: {
            status: { name: target.statusValue },
        },
        Duration: {
            rich_text: [{ text: { content: input.durationText } }],
        },
        Recorded: {
            date: { start: input.startTimeIso },
        },
    };

    if (target.typeSelect !== null) {
        properties.Type = { select: { name: target.typeSelect } };
    }

    if (target.selectStatusProperty !== null) {
        properties[target.selectStatusProperty] = {
            select: { name: target.selectStatusValue },
        };
    }

    const language = input.detectedLanguage?.toLowerCase();
    if (language === "dutch" || language === "english") {
        properties.Language = { select: { name: language } };
    }

    return properties;
}
