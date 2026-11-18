import { describe, expect, it } from "vitest";
import {
    buildTranscriptionProperties,
    masterTarget,
    mtTarget,
} from "../lib/notion/targets";

const input = {
    pageTitle: "do 08-05-26 | 19m",
    durationText: "19m 45s",
    startTimeIso: "2026-05-08T10:00:00.000Z",
    detectedLanguage: "dutch",
};

describe("buildTranscriptionProperties — master", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test reads dynamic Notion property shapes
    const p = buildTranscriptionProperties(masterTarget("db-master"), input) as any;
    it("uses Name title and Transcript type", () => {
        expect(p.Name.title[0].text.content).toBe("do 08-05-26 | 19m");
        expect(p.Type.select.name).toBe("Transcript");
    });
    it("sets Bron, status-type Status=Inbox, Duration, Recorded, Language", () => {
        expect(p.Bron.select.name).toBe("Plaud");
        expect(p.Status.status.name).toBe("Inbox");
        expect(p.Duration.rich_text[0].text.content).toBe("19m 45s");
        expect(p.Recorded.date.start).toBe("2026-05-08T10:00:00.000Z");
        expect(p.Language.select.name).toBe("dutch");
    });
    it("has no select-type Status and no Titel", () => {
        expect(p.Titel).toBeUndefined();
        expect(p["Status 1"]).toBeUndefined();
    });
});

describe("buildTranscriptionProperties — MT", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test reads dynamic Notion property shapes
    const p = buildTranscriptionProperties(mtTarget("db-mt"), input) as any;
    it("uses Titel and omits Type entirely", () => {
        expect(p.Titel.title[0].text.content).toBe("do 08-05-26 | 19m");
        expect(p.Type).toBeUndefined();
        expect(p.Name).toBeUndefined();
    });
    it("sets status-type 'Status 1'=Inbox and select Status=Getranscribeerd", () => {
        expect(p["Status 1"].status.name).toBe("Inbox");
        expect(p.Status.select.name).toBe("Getranscribeerd");
    });
    it("keeps shared Bron/Duration/Recorded/Language", () => {
        expect(p.Bron.select.name).toBe("Plaud");
        expect(p.Duration.rich_text[0].text.content).toBe("19m 45s");
        expect(p.Recorded.date.start).toBe("2026-05-08T10:00:00.000Z");
        expect(p.Language.select.name).toBe("dutch");
    });
});

describe("buildTranscriptionProperties — language", () => {
    it("omits Language when not dutch/english", () => {
        const p = buildTranscriptionProperties(mtTarget("db-mt"), {
            ...input,
            detectedLanguage: "german",
            // biome-ignore lint/suspicious/noExplicitAny: test reads dynamic Notion property shapes
        }) as any;
        expect(p.Language).toBeUndefined();
    });
});
