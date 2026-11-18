# MT-transcripties routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route MT-cadence recordings (titles containing MT/Monthly/Quarterly/Yearly/Unbound) to the "MT transcripties" Notion database; everything else keeps going to "Master transcripties" unchanged.

**Architecture:** Add a pure title predicate and a pure per-target property builder, then branch inside the single existing Notion write function (`syncTranscriptionToNotion`) on the recording's Plaud title (`recordings.filename`). The MT write reuses the same Notion integration token as Master; only the database id and a few property shapes differ.

**Tech Stack:** TypeScript, Next.js, Drizzle, `@notionhq/client`, Vitest (node env), Zod (env).

**Spec:** `.context/attachments/PfXEed/2026-11-18_openplaud_mt-routing_conductor-spec_v01.md`

## Global Constraints

- All Notion writes go through `syncTranscriptionToNotion` in `src/lib/notion/sync.ts` (callers: manual `recordings/[id]/notion` route, `notion/bulk-sync` route, auto-transcribe in `transcribe-recording.ts`). Route in that one place only.
- Routing key is `recordings.filename` (holds the Plaud recording title).
- MT database_id: `7a5cd371-de2b-475d-86be-44ed32f2c6dc` (data_source `663f8c67-28f7-450a-a3c7-19646a467dc4`). Overridable via env `NOTION_MT_DATABASE_ID`.
- MT uses the **same** integration token as Master (from the existing `getNotionConfig`). Prerequisite: that integration must have the MT database shared with it — not a code change; verify in QA.
- MT property facts (verified against the live schema, 2026-11-18): title property is **`Titel`**; status-type is **`Status 1`** (options Inbox/Active/Done/Delete); there is also a **select** named `Status` (options Getranscribeerd/Samengevat/Gearchiveerd); `Bron` select has option `Plaud`; `Type` select has **no** "Transcript" option; `Duration`/`Recorded`/`Language` match Master.
- Confirmed decisions (from the user, keep verbatim): routing = whole-word case-insensitive contains; MT `Type` = **left empty**; MT title = **same date-format as Master** (`"do 08-05-26 | 19m"` via existing `formatTranscriptTitle`); MT status = select `Status`=`Getranscribeerd` **and** status-type `Status 1`=`Inbox` (mirror Master's Inbox triage).
- Keep the Master path byte-for-byte equivalent in behaviour. Do not introduce a `Transcript` option into the MT `Type` select.
- Page body blocks (`buildNotionPageContent`) are identical for both databases — do not change them.

## Review Focus

- Keyword as a substring but not a whole word (e.g. "commitment", "format") must **not** route to MT — pinned in Task 1's test (`\b` boundaries).
- Dutch "jaar"/"voorjaarsoverleg"/"najaarsaanbieding" must **not** match "Yearly" — pinned in Task 1's test.
- Case variations ("mt monthly", "UNBOUND", "quarterly") must route to MT — pinned in Task 1's test.
- Empty/whitespace filename must route to Master (predicate false) — pinned in Task 1's test.
- MT properties must omit `Type` entirely (prevents auto-creating a junk select option) — pinned in Task 2's MT builder test.

---

### Task 1: Title routing predicate

**Files:**
- Create: `src/lib/notion/routing.ts`
- Test: `src/tests/notion-routing.test.ts`

**Interfaces:**
- Produces: `isMtCadenceTitle(title: string | null | undefined): boolean`

- [ ] **Step 1: Write the failing test** in `src/tests/notion-routing.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { isMtCadenceTitle } from "../lib/notion/routing";

describe("isMtCadenceTitle", () => {
    it("matches MT as a standalone token", () => {
        expect(isMtCadenceTitle("MT-overleg")).toBe(true);
        expect(isMtCadenceTitle("MT monthly nov")).toBe(true);
        expect(isMtCadenceTitle("Maandelijkse MT")).toBe(true);
    });
    it("matches the English cadence words as whole words, case-insensitively", () => {
        expect(isMtCadenceTitle("Monthly recap")).toBe(true);
        expect(isMtCadenceTitle("Q3 Quarterly")).toBe(true);
        expect(isMtCadenceTitle("yearly planning")).toBe(true);
        expect(isMtCadenceTitle("UNBOUND sessie")).toBe(true);
    });
    it("routes ordinary meetings to Master", () => {
        expect(isMtCadenceTitle("Commercieel overleg")).toBe(false);
        expect(isMtCadenceTitle("format update")).toBe(false); // substring 'mt' not a word
        expect(isMtCadenceTitle("commitment call")).toBe(false);
    });
    it("does not match the Dutch 'jaar' family", () => {
        expect(isMtCadenceTitle("Voorjaarsoverleg")).toBe(false);
        expect(isMtCadenceTitle("najaarsaanbieding bespreken")).toBe(false);
    });
    it("handles empty/missing titles", () => {
        expect(isMtCadenceTitle("")).toBe(false);
        expect(isMtCadenceTitle("   ")).toBe(false);
        expect(isMtCadenceTitle(null)).toBe(false);
        expect(isMtCadenceTitle(undefined)).toBe(false);
    });
    it("accepts the known false positive (per spec decision)", () => {
        expect(isMtCadenceTitle("SR <> BB quarterly preps")).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/notion-routing.test.ts`
Expected: FAIL ("isMtCadenceTitle is not a function" / module not found).

- [ ] **Step 3: Implement `isMtCadenceTitle` in `src/lib/notion/routing.ts`**

Case-insensitive whole-word match against `MT`, `Monthly`, `Quarterly`, `Yearly`, `Unbound` using a single regex with `\b` boundaries (e.g. `/\b(?:MT|Monthly|Quarterly|Yearly|Unbound)\b/i`). Return `false` for null/undefined/blank. Export the keyword list as a named const so the test and future callers share it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/notion-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notion/routing.ts src/tests/notion-routing.test.ts
git commit -m "feat: add MT-cadence title routing predicate"
```

---

### Task 2: Per-target Notion property builder

**Files:**
- Create: `src/lib/notion/targets.ts`
- Modify: `src/lib/env.ts` (add optional `NOTION_MT_DATABASE_ID`)
- Test: `src/tests/notion-targets.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `const DEFAULT_MT_DATABASE_ID = "7a5cd371-de2b-475d-86be-44ed32f2c6dc"`
  - `interface NotionWriteTarget { databaseId: string; titleProperty: string; typeSelect: string | null; statusProperty: string; statusValue: string; selectStatusProperty: string | null; selectStatusValue: string | null }`
  - `function masterTarget(databaseId: string): NotionWriteTarget`
  - `function mtTarget(databaseId: string): NotionWriteTarget`
  - `function buildTranscriptionProperties(target: NotionWriteTarget, input: { pageTitle: string; durationText: string; startTimeIso: string; detectedLanguage: string | null }): Record<string, unknown>`

Target values (exact):
- `masterTarget`: `{ titleProperty: "Name", typeSelect: "Transcript", statusProperty: "Status", statusValue: "Inbox", selectStatusProperty: null, selectStatusValue: null }`.
- `mtTarget`: `{ titleProperty: "Titel", typeSelect: null, statusProperty: "Status 1", statusValue: "Inbox", selectStatusProperty: "Status", selectStatusValue: "Getranscribeerd" }`.

Builder rules: always set `Bron` select `Plaud`, `Duration` rich_text = `durationText`, `Recorded` date start = `startTimeIso`, and `[titleProperty]` title = `pageTitle`. Set `[statusProperty]` as a **status** type = `statusValue`. Set `Type` select = `typeSelect` **only when non-null**. Set `[selectStatusProperty]` as a **select** = `selectStatusValue` **only when `selectStatusProperty` non-null**. Add `Language` select only when `detectedLanguage?.toLowerCase()` is `"dutch"` or `"english"` (reuse current logic).

- [ ] **Step 1: Write the failing test** in `src/tests/notion-targets.test.ts`

```ts
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
        }) as any;
        expect(p.Language).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/notion-targets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/notion/targets.ts`** per the Interfaces block, and add `NOTION_MT_DATABASE_ID: z.string().optional()` to `src/lib/env.ts` (schema entry **and** the `envSchema.parse({...})` object, mirroring `NOTION_DATABASE_ID`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/notion-targets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notion/targets.ts src/tests/notion-targets.test.ts src/lib/env.ts
git commit -m "feat: add Notion write targets and property builder"
```

---

### Task 3: Branch the Notion write on the recording title

**Files:**
- Modify: `src/lib/notion/sync.ts`

**Interfaces:**
- Consumes: `isMtCadenceTitle` (Task 1); `masterTarget`, `mtTarget`, `buildTranscriptionProperties`, `DEFAULT_MT_DATABASE_ID` (Task 2); `env.NOTION_MT_DATABASE_ID` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Rewire `syncTranscriptionToNotion`**

In `src/lib/notion/sync.ts`, after loading `recording` and `config`, compute:
`const target = isMtCadenceTitle(recording.filename) ? mtTarget(env.NOTION_MT_DATABASE_ID ?? DEFAULT_MT_DATABASE_ID) : masterTarget(config.databaseId);`
Replace the inline `properties` object with `const properties = buildTranscriptionProperties(target, { pageTitle, durationText: formatDuration(recording.duration), startTimeIso: recording.startTime.toISOString(), detectedLanguage: txn.detectedLanguage ?? null });`. Create the page with `parent: { database_id: target.databaseId }`. Leave the `createNotionClientFromToken(config.token)`, block-batch append, status-DB updates, and error handling unchanged. Add a one-line log of the chosen target (name only, no token), e.g. `[notion-sync] target=${isMt ? "MT" : "Master"}`.

- [ ] **Step 2: Type-check**

Run: `npm run type-check`
Expected: PASS (no type errors).

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (existing + new tests; `transcription.test.ts` still green since it mocks `syncTranscriptionToNotion`).

- [ ] **Step 4: Lint/format**

Run: `npm run format-and-lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notion/sync.ts
git commit -m "feat: route MT-cadence transcriptions to the MT Notion database"
```

---

## Manual QA (not unit-testable; network/DB-bound)

1. Confirm the OpenPlaud integration token has the "MT transcripties" database shared with it (spec prerequisite). If not, share it in Notion.
2. In the running app, a recording titled e.g. "MT monthly" → transcribe → lands in **MT transcripties** with `Titel` filled, `Status`=Getranscribeerd, `Status 1`=Inbox, `Bron`=Plaud, no `Type`.
3. A recording titled "Commercieel overleg" → lands in **Master transcripties** exactly as before.
4. Confirm no new "Transcript" option appeared in the MT `Type` select.
