/**
 * Plaud 4.0 ("sigma") API shapes and the id arithmetic around them.
 *
 * Plaud migrated accounts to a new backend on the same host. The old
 * `/file/*` endpoints answer `-1800907 Account migrated to 4.0` for a
 * migrated account, even with a freshly issued token, so the only way back
 * to a working sync is to speak the new `/file-app/v4/*` API.
 *
 * The 4.0 model is a tree, not a flat file list:
 *
 *   Recordings folder (system_folder_type 1)
 *     └── recording node   (one per recording, named after its timestamp)
 *           └── file node  (carries the file_id the detail endpoint wants)
 *
 * Crucially, migrated recordings kept their old identifier: a recording that
 * used to be `c07e6300…` is now the node `on_w_c07e6300…` holding the file
 * `of_c07e6300…`. Stripping the prefix therefore maps a 4.0 node straight
 * onto the `recordings.plaud_file_id` rows that are already in the database,
 * which is what keeps a port from re-importing every recording as new.
 * Recordings made after the migration have unrelated `n_…` / `f_…` ids.
 */

import type { PlaudRecording } from "@/types/plaud";

/** Virtual parent of the system folders. */
export const V4_ROOT_NODE = "root";

/** `system_folder_type` of the folder that holds the recordings. */
export const V4_RECORDINGS_FOLDER_TYPE = 1;

const MIGRATED_NODE_PREFIX = "on_w_";
const MIGRATED_FILE_PREFIX = "of_";
const NATIVE_NODE_PREFIX = "n_";

/**
 * Marker on a `recordings.plaud_version` value that came from the 4.0 API.
 *
 * The legacy API and 4.0 number their versions independently, so a legacy
 * value can never be compared against a 4.0 `version_ms`. Without a way to
 * tell the two apart every pre-migration recording looks changed on the
 * first 4.0 sync and the whole back catalogue downloads again. Tagging the
 * 4.0 values keeps that apart: an untagged value means "stored before the
 * migration", not "changed".
 */
const V4_VERSION_PREFIX = "v4:";

/** The `plaud_version` to store for a recording synced through 4.0. */
export function v4VersionKey(versionMs: number): string {
    return `${V4_VERSION_PREFIX}${versionMs}`;
}

/** True when a stored `plaud_version` was written by the 4.0 path. */
export function isV4VersionKey(stored: string | null): boolean {
    return stored?.startsWith(V4_VERSION_PREFIX) ?? false;
}

export interface PlaudV4Node {
    node_id: string;
    name: string;
    type: number;
    file_id: string;
    icon: string;
    system_folder_type: number;
    child_count: number;
    duration_ms: number;
    created_at_show_ms: number;
    updated_at_show_ms: number;
    version_ms: number;
    status: number;
}

export interface PlaudV4ListResponse {
    status: number;
    data: {
        items: PlaudV4Node[];
        /** Opaque; empty string when there is no further page. */
        next_cursor: string;
    };
}

export interface PlaudV4Object {
    object_id: string;
    object_type: string;
    mime_type: string;
    object_size: number;
    /** Presigned S3 URL. Short-lived, so fetch it per download. */
    content_url: string;
}

export interface PlaudV4FileDetail {
    status: number;
    data: {
        meta: {
            file_id: string;
            file_type: string;
            duration: number;
            start_time: number;
            size_bytes: number;
            serial_number: string;
            version_ms: number;
            timezone_iana: string;
        };
        node: {
            node_id: string;
            name: string;
            version_ms: number;
        };
        objects: PlaudV4Object[];
    };
}

/** True for a recording created after the 4.0 migration. */
export function isNativeV4Node(nodeId: string): boolean {
    return nodeId.startsWith(NATIVE_NODE_PREFIX);
}

/**
 * The id to store in `recordings.plaud_file_id` for a 4.0 recording node.
 *
 * Migrated nodes resolve to their pre-migration id so existing rows keep
 * matching; native 4.0 nodes keep the node id, because it is the only handle
 * a later sync gets back from the folder listing.
 */
export function recordingIdFromNode(nodeId: string): string {
    return nodeId.startsWith(MIGRATED_NODE_PREFIX)
        ? nodeId.slice(MIGRATED_NODE_PREFIX.length)
        : nodeId;
}

/** Inverse of {@link recordingIdFromNode}. */
export function nodeIdFromRecordingId(recordingId: string): string {
    return isNativeV4Node(recordingId)
        ? recordingId
        : MIGRATED_NODE_PREFIX + recordingId;
}

/**
 * The 4.0 file id of a migrated recording, derived without an API call.
 * Returns null for native 4.0 recordings, whose file id has to be looked up
 * through the node's content listing.
 */
export function migratedFileId(recordingId: string): string | null {
    return isNativeV4Node(recordingId)
        ? null
        : MIGRATED_FILE_PREFIX + recordingId;
}

/** The playable audio object of a file detail response, if there is one. */
export function audioObject(
    detail: PlaudV4FileDetail["data"],
): PlaudV4Object | undefined {
    return detail.objects?.find((o) => o.object_type === "AUDIO");
}

/**
 * Map a 4.0 file detail onto the legacy `PlaudRecording` the sync works with.
 *
 * Several legacy fields have no 4.0 counterpart. `file_md5` is gone, and the
 * numeric `timezone`/`zonemins`/`scene` triplet was replaced by an IANA zone
 * name, so they fall back to neutral values rather than inventing data.
 * `meta.size_bytes` reads 0 on the recordings seen so far; the audio object's
 * own size is the honest number.
 */
export function toPlaudRecording(
    node: PlaudV4Node,
    detail: PlaudV4FileDetail["data"],
): PlaudRecording {
    const audio = audioObject(detail);
    const duration = detail.meta.duration || 0;
    // A zero start_time would date the recording to 1970, so treat it as
    // missing rather than absent-or-null: the node's own timestamp is the
    // better answer.
    const startTime = detail.meta.start_time || node.created_at_show_ms;

    return {
        id: recordingIdFromNode(node.node_id),
        filename: detail.node.name || node.name,
        keywords: [],
        filesize: audio?.object_size ?? detail.meta.size_bytes ?? 0,
        filetype: audio?.mime_type ?? "",
        fullname: detail.node.name || node.name,
        file_md5: "",
        ori_ready: true,
        version: 0,
        version_ms: node.version_ms,
        edit_time: node.updated_at_show_ms,
        edit_from: "",
        is_trash: false,
        start_time: startTime,
        end_time: startTime + duration,
        duration,
        timezone: 0,
        zonemins: 0,
        scene: 0,
        filetag_id_list: [],
        serial_number: detail.meta.serial_number ?? "",
        is_trans: false,
        is_summary: false,
    };
}
