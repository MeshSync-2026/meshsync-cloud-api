import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDb } from "../src/db.js";
import { createServer } from "../src/server.js";
import {
    EVENT_TYPE,
    ACTOR_ROLE,
    REPORT_TYPE,
    SEVERITY,
    CLOUD_NODE_ID,
} from "@meshsync/shared/enums";
import { HlcClock, formatHlc, nodeSlot } from "@meshsync/shared/hlc";

// Helper to create a valid event
let evtSeq = 0;
function makeEvent(overrides = {}) {
    evtSeq++;
    const nodeId = overrides.origin_node_id || "device-001";
    const physical = overrides.created_at || Date.now();
    return {
        id: `evt-${String(evtSeq).padStart(4, "0")}`,
        parent_id: null,
        incident_id: "inc-0001",
        origin_node_id: nodeId,
        seq: evtSeq,
        event_type_code: EVENT_TYPE.SOS_CREATED,
        actor_role_code: ACTOR_ROLE.VICTIM,
        latitude: 6.9271,
        longitude: 79.8612,
        landmark_name: null,
        report_type_code: REPORT_TYPE.SOS,
        category_code: null,
        severity_level: SEVERITY.HIGH,
        status_safety: 0,
        people_count: 1,
        status_water: 0,
        status_injury: 0,
        target_node_id: null,
        target_zone_id: null,
        hlc_timestamp: formatHlc(physical, evtSeq, nodeSlot(nodeId)),
        created_at: physical,
        ...overrides,
    };
}

describe("Edge Sync — InMemoryDb.ingestEvents", () => {
    test("inserts valid events and rebuilds projections", async () => {
        const db = new InMemoryDb();
        const events = [
            makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, incident_id: "inc-1" }),
        ];
        const result = await db.ingestEvents(events, "mule-1");
        assert.equal(result.newCount, 1);
        assert.equal(result.duplicateCount, 0);
        assert.equal(result.rejectedCount, 0);

        const incidents = await db.getIncidents();
        assert.equal(incidents.length, 1);
        assert.equal(incidents[0].id, "inc-1");
    });

    test("idempotent — duplicate events are ignored (§11.4)", async () => {
        const db = new InMemoryDb();
        const events = [makeEvent({ id: "e1", incident_id: "inc-1" })];
        await db.ingestEvents(events, "mule-1");
        // Ingest the same event again (mule retry)
        const result2 = await db.ingestEvents(events, "mule-1");
        assert.equal(result2.newCount, 0);
        assert.equal(result2.duplicateCount, 1);
    });

    test("rejects invalid events gracefully (per-row, not per-batch)", async () => {
        const db = new InMemoryDb();
        const events = [
            makeEvent({ id: "e1", incident_id: "inc-1" }),
            { id: "e2", incident_id: "inc-1", origin_node_id: null, seq: 2, event_type_code: 1, hlc_timestamp: "0001754611200|00042|a3f9c1e7", created_at: Date.now() },
        ];
        const result = await db.ingestEvents(events, "mule-1");
        assert.equal(result.newCount, 1);
        assert.equal(result.rejectedCount, 1);
    });

    test("logs ingestion batch with counts", async () => {
        const db = new InMemoryDb();
        await db.ingestEvents([makeEvent({ id: "e1", incident_id: "inc-1" })], "mule-1");
        const batches = await db.getBatches();
        assert.equal(batches.length, 1);
        assert.equal(batches[0].new_count, 1);
        assert.equal(batches[0].uploading_node_id, "mule-1");
    });
});

describe("Edge Sync — projections", () => {
    test("SOS → responder → resolve produces correct projection", async () => {
        const db = new InMemoryDb();
        const now = Date.now();
        await db.ingestEvents([
            makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, origin_node_id: "victim-1", incident_id: "inc-1", hlc_timestamp: formatHlc(now, 1, nodeSlot("victim-1")) }),
            makeEvent({ id: "e2", event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE, origin_node_id: "responder-1", actor_role_code: ACTOR_ROLE.CIVILIAN_RESPONDER, incident_id: "inc-1", hlc_timestamp: formatHlc(now + 1000, 1, nodeSlot("responder-1")) }),
            makeEvent({ id: "e3", event_type_code: EVENT_TYPE.SOS_RESOLVED, origin_node_id: "responder-1", incident_id: "inc-1", hlc_timestamp: formatHlc(now + 2000, 2, nodeSlot("responder-1")) }),
        ], "mule-1");

        const incidents = await db.getIncidents();
        assert.equal(incidents[0].status_code, 5); // RESOLVED
        assert.equal(incidents[0].confidence_code, 3); // RESOLVED

        const responders = await db.getRespondersByIncident("inc-1");
        assert.equal(responders.length, 1);
        assert.equal(responders[0].responder_node_id, "responder-1");

        const history = await db.getHistoryByIncident("inc-1");
        assert.ok(history.length >= 3);
    });

    test("concurrent responders both preserved (§4)", async () => {
        const db = new InMemoryDb();
        const now = Date.now();
        await db.ingestEvents([
            makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, origin_node_id: "victim-1", incident_id: "inc-1", hlc_timestamp: formatHlc(now, 1, nodeSlot("victim-1")) }),
            makeEvent({ id: "e2", event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE, origin_node_id: "responder-A", incident_id: "inc-1", hlc_timestamp: formatHlc(now + 1000, 1, nodeSlot("responder-A")) }),
            makeEvent({ id: "e3", event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE, origin_node_id: "responder-B", incident_id: "inc-1", hlc_timestamp: formatHlc(now + 1000, 1, nodeSlot("responder-B")) }),
        ], "mule-1");

        const responders = await db.getRespondersByIncident("inc-1");
        assert.equal(responders.length, 2);
    });
});

describe("Edge Sync — emitAssignEvent", () => {
    test("emits ASSIGN event with CLOUD-0000 origin", async () => {
        const db = new InMemoryDb();
        const event = await db.emitAssignEvent({
            targetNodeId: "responder-1",
            targetZoneId: "zone-001",
            incidentId: "inc-1",
        });
        assert.equal(event.origin_node_id, CLOUD_NODE_ID);
        assert.equal(event.event_type_code, EVENT_TYPE.ASSIGN);
        assert.equal(event.target_node_id, "responder-1");
        assert.equal(event.target_zone_id, "zone-001");

        const assignments = await db.getAssignments();
        assert.equal(assignments.length, 1);
    });
});

describe("Edge Sync — GET /sync", () => {
    test("returns events above the HLC watermark", async () => {
        const db = new InMemoryDb();
        await db.ingestEvents([
            makeEvent({ id: "e1", incident_id: "inc-1", hlc_timestamp: formatHlc(1000, 0, "00000001") }),
            makeEvent({ id: "e2", incident_id: "inc-1", hlc_timestamp: formatHlc(2000, 0, "00000001") }),
            makeEvent({ id: "e3", incident_id: "inc-1", hlc_timestamp: formatHlc(3000, 0, "00000001") }),
        ], "mule-1");

        const events = await db.getSyncEvents(formatHlc(1500, 0, "00000001"));
        assert.equal(events.length, 2); // e2 and e3 are above 1500
    });
});

describe("Edge Sync — HTTP server", () => {
    test("GET /health returns ok", async () => {
        const { server, db } = createServer();
        const port = await listen(server);
        try {
            const res = await fetch(`http://localhost:${port}/health`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.status, "ok");
        } finally {
            server.close();
        }
    });

    test("POST /ingest accepts events and returns batch result", async () => {
        const { server } = createServer();
        const port = await listen(server);
        try {
            const res = await fetch(`http://localhost:${port}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    uploading_node_id: "mule-1",
                    events: [makeEvent({ id: "http-e1", incident_id: "http-inc-1" })],
                }),
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.new_count, 1);
        } finally {
            server.close();
        }
    });

    test("GET /incidents returns projection", async () => {
        const { server } = createServer();
        const port = await listen(server);
        try {
            // First ingest an event
            await fetch(`http://localhost:${port}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    events: [makeEvent({ id: "http-e2", incident_id: "http-inc-2" })],
                }),
            });
            const res = await fetch(`http://localhost:${port}/incidents`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.ok(body.incidents.length >= 1);
        } finally {
            server.close();
        }
    });

    test("POST /internal/assign emits ASSIGN event", async () => {
        const { server } = createServer();
        const port = await listen(server);
        try {
            const res = await fetch(`http://localhost:${port}/internal/assign`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    target_node_id: "responder-1",
                    target_zone_id: "zone-001",
                }),
            });
            const body = await res.json();
            assert.equal(res.status, 201);
            assert.equal(body.origin_node_id, CLOUD_NODE_ID);
            assert.equal(body.target_node_id, "responder-1");
        } finally {
            server.close();
        }
    });

    test("GET /sync returns events", async () => {
        const { server } = createServer();
        const port = await listen(server);
        try {
            await fetch(`http://localhost:${port}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    events: [makeEvent({ id: "sync-e1", incident_id: "sync-inc-1" })],
                }),
            });
            const res = await fetch(`http://localhost:${port}/sync`);
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.ok(body.events.length >= 1);
        } finally {
            server.close();
        }
    });
});

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, () => {
            const addr = server.address();
            resolve(addr.port);
        });
    });
}