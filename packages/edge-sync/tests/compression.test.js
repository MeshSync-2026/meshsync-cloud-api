import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createServer } from "../src/server.js";
import { EVENT_TYPE, REPORT_TYPE, SEVERITY } from "@meshsync/shared/enums";
import { formatHlc, nodeSlot } from "@meshsync/shared/hlc";

function makeEvent(id = "comp-evt-1") {
    const now = Date.now();
    return {
        id,
        parent_id: null,
        incident_id: "comp-inc-1",
        origin_node_id: "mule-node-01",
        seq: 1,
        event_type_code: EVENT_TYPE.SOS_CREATED,
        actor_role_code: 1,
        latitude: 6.9271,
        longitude: 79.8612,
        landmark_name: "Galle Face",
        report_type_code: REPORT_TYPE.SOS,
        category_code: null,
        severity_level: SEVERITY.HIGH,
        status_safety: 0,
        people_count: 2,
        status_water: 0,
        status_injury: 0,
        target_node_id: null,
        target_zone_id: null,
        hlc_timestamp: formatHlc(now, 1, nodeSlot("mule-node-01")),
        created_at: now,
    };
}

describe("Edge Sync — Decompression & Payload Handling", () => {
    test("POST /ingest handles gzip compressed batch", async () => {
        const { server } = createServer();
        const port = await listen(server);

        try {
            const payload = JSON.stringify({
                uploading_node_id: "mule-001",
                events: [makeEvent("gzip-e1")],
            });

            const compressed = zlib.gzipSync(Buffer.from(payload, "utf8"));

            const res = await fetch(`http://localhost:${port}/ingest`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                },
                body: compressed,
            });

            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.new_count, 1);
            assert.equal(body.is_cloud_synced, true);
            assert.deepEqual(body.ack_ids, ["gzip-e1"]);
        } finally {
            server.close();
        }
    });

    test("POST /ingest handles deflate compressed batch", async () => {
        const { server } = createServer();
        const port = await listen(server);

        try {
            const payload = JSON.stringify({
                uploading_node_id: "mule-002",
                events: [makeEvent("deflate-e1")],
            });

            const compressed = zlib.deflateSync(Buffer.from(payload, "utf8"));

            const res = await fetch(`http://localhost:${port}/ingest`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Encoding": "deflate",
                },
                body: compressed,
            });

            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.new_count, 1);
            assert.deepEqual(body.ack_ids, ["deflate-e1"]);
        } finally {
            server.close();
        }
    });

    test("POST /ingest rejects corrupted compressed payload", async () => {
        const { server } = createServer();
        const port = await listen(server);

        try {
            const res = await fetch(`http://localhost:${port}/ingest`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Encoding": "gzip",
                },
                body: Buffer.from("not-valid-gzip-bytes"),
            });

            assert.ok(res.status >= 400);
        } finally {
            server.close();
        }
    });
});

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, () => {
            resolve(server.address().port);
        });
    });
}
