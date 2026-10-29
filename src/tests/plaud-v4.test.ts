import { describe, expect, it } from "vitest";

import {
    audioObject,
    isNativeV4Node,
    migratedFileId,
    nodeIdFromRecordingId,
    type PlaudV4FileDetail,
    type PlaudV4Node,
    recordingIdFromNode,
    toPlaudRecording,
} from "../lib/plaud/v4";

/** A recording that predates the 4.0 migration, as 4.0 now reports it. */
const LEGACY_ID = "c07e630055c3ad3d0a294c05cc85f072";

const migratedNode: PlaudV4Node = {
    node_id: `on_w_${LEGACY_ID}`,
    name: "2026-10-28 17:01:13",
    type: 1,
    file_id: "",
    icon: "",
    system_folder_type: 0,
    child_count: 1,
    duration_ms: 0,
    created_at_show_ms: 1793203273159,
    updated_at_show_ms: 1793203280000,
    version_ms: 1793203280001,
    status: 1,
};

const migratedDetail: PlaudV4FileDetail["data"] = {
    meta: {
        file_id: `of_${LEGACY_ID}`,
        file_type: "REC",
        duration: 3259000,
        start_time: 1793203273159,
        size_bytes: 0,
        serial_number: "1793203273159",
        version_ms: 1793203280001,
        timezone_iana: "Europe/Amsterdam",
    },
    node: {
        node_id: `on_f_${LEGACY_ID}`,
        name: "AI Infrastructure Development",
        version_ms: 1793203280001,
    },
    objects: [
        {
            object_id: "o_1",
            object_type: "AUDIO",
            mime_type: "audio/ogg",
            object_size: 13905920,
            content_url: "https://example.invalid/audio.ogg?X-Amz-Signature=x",
        },
    ],
};

describe("4.0 node identity", () => {
    it("maps a migrated node back onto its pre-migration id", () => {
        expect(recordingIdFromNode(`on_w_${LEGACY_ID}`)).toBe(LEGACY_ID);
    });

    it("keeps a native 4.0 node id as-is", () => {
        const native = "n_01a186f1255072149f731f9f4b175858";
        expect(recordingIdFromNode(native)).toBe(native);
        expect(isNativeV4Node(native)).toBe(true);
    });

    it("round-trips between stored id and node id", () => {
        expect(nodeIdFromRecordingId(LEGACY_ID)).toBe(`on_w_${LEGACY_ID}`);
        expect(recordingIdFromNode(nodeIdFromRecordingId(LEGACY_ID))).toBe(
            LEGACY_ID,
        );
    });

    it("derives a migrated file id without an API call", () => {
        expect(migratedFileId(LEGACY_ID)).toBe(`of_${LEGACY_ID}`);
    });

    it("cannot derive a file id for a native 4.0 recording", () => {
        expect(migratedFileId("n_01a186f1255072149f731f9f4b175858")).toBeNull();
    });
});

describe("toPlaudRecording", () => {
    it("maps a migrated recording onto the legacy shape", () => {
        const rec = toPlaudRecording(migratedNode, migratedDetail);

        // The id must match the row already in the database, or the sync
        // re-imports every pre-migration recording as new.
        expect(rec.id).toBe(LEGACY_ID);
        expect(rec.duration).toBe(3259000);
        expect(rec.start_time).toBe(1793203273159);
        expect(rec.end_time).toBe(1793203273159 + 3259000);
        expect(rec.version_ms).toBe(1793203280001);
        expect(rec.serial_number).toBe("1793203273159");
        expect(rec.filename).toBe("AI Infrastructure Development");
    });

    it("takes the file size from the audio object, not the empty meta", () => {
        const rec = toPlaudRecording(migratedNode, migratedDetail);
        expect(rec.filesize).toBe(13905920);
        expect(rec.filetype).toBe("audio/ogg");
    });

    it("falls back to the node timestamp when meta has no start time", () => {
        const detail = {
            ...migratedDetail,
            meta: { ...migratedDetail.meta, start_time: 0, duration: 0 },
        };
        const rec = toPlaudRecording(migratedNode, detail);
        expect(rec.start_time).toBe(migratedNode.created_at_show_ms);
        expect(rec.end_time).toBe(migratedNode.created_at_show_ms);
    });

    it("survives a detail response without an audio object", () => {
        const detail = { ...migratedDetail, objects: [] };
        const rec = toPlaudRecording(migratedNode, detail);
        expect(audioObject(detail)).toBeUndefined();
        expect(rec.filesize).toBe(0);
        expect(rec.filetype).toBe("");
    });
});
