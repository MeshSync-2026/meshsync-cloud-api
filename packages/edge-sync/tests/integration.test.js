// Integration test — full Data Mule round-trip
// Architecture Plan §11 (Sync Protocol)
//
// This test exercises the full pipeline:
//   1. Device creates events (SOS, responder, resolve)
//   2. Data Mule collects events from the mesh
//   3. Data Mule uploads to Edge Sync via POST /ingest
//   4. Edge Sync validates, inserts, rebuilds projections
//   5. Command Center reads incidents from Edge Sync
//   6. Commander dispatches a responder via Command Center
//   7. Command Center calls Edge Sync /internal/assign
//   8. Edge Sync emits ASSIGN event and rebuilds projections
//   9. Data Mule pulls new events via GET /sync

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer as createEdgeSync } from "@meshsync/edge-sync";
import { createServer as createCommandCenter } from "@meshsync/command-center";
import {
    EVENT_TYPE,
    ACTOR_ROLE,
    REPORT_TYPE,
    SEVERITY,
    CLOUD_NODE_ID,
} from "@meshsync/shared/enums";
import { HlcClock, formatHlc, nodeSlot } from "@meshsync/shared/hlc";

describe("Integration — Full Data Mule round-trip", () => {
    test("device → mule → cloud → dashboard → dispatch → mule pull", async () => {
        // --- Set up both services ---
        const { server: edgeServer, db: edgeDb } = createEdgeSync();
        const { server: ccServer, db: ccDb } = createCommandCenter();

        // Wire Command Center to Edge Sync
        ccDb.edgeSyncClient = {
            emitAssign: async (payload) => {
                return edgeDb.emitAssignEvent({
                    targetNodeId: payload.target_node_id,
                    targetZoneId: payload.target_zone_id,
                    incidentId: payload.incident_id,
                    assignedByAdminId: payload.assigned_by_admin_id,
                });
            },
            getIncidents: async () => edgeDb.getIncidents(),
        };

        const edgePort = await listen(edgeServer);
        const ccPort = await listen(ccServer);

        try {
            // --- Step 1: Device creates events ---
            const victimClock = new HlcClock("victim-device-001");
            const responderClock = new HlcClock("responder-device-001");

            const sosHlc = victimClock.tick();
            // Responder receives the SOS before responding — establishes causality
            responderClock.receive(sosHlc);

            const sosEvent = {
                id: "sos-001",
                parent_id: null,
                incident_id: "incident-001",
                origin_node_id: "victim-device-001",
                seq: 1,
                event_type_code: EVENT_TYPE.SOS_CREATED,
                actor_role_code: ACTOR_ROLE.VICTIM,
                latitude: 6.9271,
                longitude: 79.8612,
                landmark_name: "Galle Face",
                report_type_code: REPORT_TYPE.SOS,
                category_code: 1, // Flood
                severity_level: SEVERITY.HIGH,
                status_safety: 1, // Need Help
                people_count: 3,
                status_water: 1, // Low
                status_injury: 1, // Minor
                target_node_id: null,
                target_zone_id: null,
                hlc_timestamp: sosHlc,
                created_at: Date.now(),
            };

            const responderEvent = {
                id: "responder-001",
                parent_id: "sos-001",
                incident_id: "incident-001",
                origin_node_id: "responder-device-001",
                seq: 1,
                event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE,
                actor_role_code: ACTOR_ROLE.CIVILIAN_RESPONDER,
                latitude: 6.9300,
                longitude: 79.8650,
                landmark_name: null,
                report_type_code: REPORT_TYPE.STATUS,
                category_code: null,
                severity_level: null,
                status_safety: null,
                people_count: null,
                status_water: null,
                status_injury: null,
                target_node_id: null,
                target_zone_id: null,
                hlc_timestamp: responderClock.tick(),
                created_at: Date.now() + 1000,
            };

            // --- Step 2-4: Data Mule uploads to Edge Sync ---
            const ingestRes = await fetch(`http://localhost:${edgePort}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    uploading_node_id: "data-mule-001",
                    events: [sosEvent, responderEvent],
                }),
            });
            const ingestBody = await ingestRes.json();
            assert.equal(ingestRes.status, 200);
            assert.equal(ingestBody.new_count, 2);
            assert.equal(ingestBody.duplicate_count, 0);

            // --- Step 5: Dashboard reads incidents from Edge Sync ---
            const incidentsRes = await fetch(`http://localhost:${edgePort}/incidents`);
            const incidentsBody = await incidentsRes.json();
            assert.equal(incidentsBody.incidents.length, 1);
            const incident = incidentsBody.incidents[0];
            assert.equal(incident.id, "incident-001");
            assert.equal(incident.status_code, 3); // EN_ROUTE
            assert.equal(incident.severity_level, SEVERITY.HIGH);

            // Verify responders
            const respondersRes = await fetch(`http://localhost:${edgePort}/incidents/incident-001/responders`);
            const respondersBody = await respondersRes.json();
            assert.equal(respondersBody.responders.length, 1);
            assert.equal(respondersBody.responders[0].responder_node_id, "responder-device-001");

            // --- Step 6: Commander dispatches a responder via Command Center ---
            // First, login as commander
            const loginRes = await fetch(`http://localhost:${ccPort}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: "anjali@meshsync.lk", password: "demo1234" }),
            });
            const loginBody = await loginRes.json();
            assert.equal(loginRes.status, 200);
            const token = loginBody.token;

            // Register a device for the dispatcher user
            const dispatcherUser = ccDb.getUsers().find((u) => u.username === "suresh@meshsync.lk");
            await fetch(`http://localhost:${ccPort}/devices`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    node_id: "officer-device-001",
                    authority_user_id: dispatcherUser.id,
                }),
            });

            // Get a zone
            const zonesRes = await fetch(`http://localhost:${ccPort}/zones`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const zonesBody = await zonesRes.json();
            const zone = zonesBody.zones[0];

            // Dispatch
            const dispatchRes = await fetch(`http://localhost:${ccPort}/dispatch/responder`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    authority_user_id: dispatcherUser.id,
                    zone_id: zone.id,
                    incident_id: "incident-001",
                }),
            });
            const dispatchBody = await dispatchRes.json();
            assert.equal(dispatchRes.status, 200);
            assert.ok(dispatchBody.event);
            assert.equal(dispatchBody.event.origin_node_id, CLOUD_NODE_ID);
            assert.equal(dispatchBody.event.target_node_id, "officer-device-001");

            // --- Step 7-8: Verify ASSIGN event was emitted and projected ---
            const assignmentsRes = await fetch(`http://localhost:${edgePort}/assignments`);
            const assignmentsBody = await assignmentsRes.json();
            assert.equal(assignmentsBody.assignments.length, 1);
            assert.equal(assignmentsBody.assignments[0].responder_node_id, "officer-device-001");

            // --- Step 9: Data Mule pulls new events via GET /sync ---
            // Pull everything after the SOS event's HLC
            const syncRes = await fetch(`http://localhost:${edgePort}/sync?since_hlc=${sosEvent.hlc_timestamp}`);
            const syncBody = await syncRes.json();
            assert.equal(syncRes.status, 200);
            assert.ok(syncBody.events.length >= 2); // responder event + ASSIGN event

            // Verify the ASSIGN event is in the sync results
            const assignEvent = syncBody.events.find((e) => e.event_type_code === EVENT_TYPE.ASSIGN);
            assert.ok(assignEvent, "ASSIGN event should be in sync results");
            assert.equal(assignEvent.target_node_id, "officer-device-001");
        } finally {
            edgeServer.close();
            ccServer.close();
        }
    });

    test("idempotent ingest — mule retry does not duplicate", async () => {
        const { server: edgeServer, db: edgeDb } = createEdgeSync();
        const edgePort = await listen(edgeServer);

        try {
            const event = {
                id: "idempotent-001",
                incident_id: "inc-idem-001",
                origin_node_id: "device-idem-001",
                seq: 1,
                event_type_code: EVENT_TYPE.SOS_CREATED,
                actor_role_code: ACTOR_ROLE.VICTIM,
                latitude: 6.9,
                longitude: 79.8,
                hlc_timestamp: formatHlc(1000, 0, nodeSlot("device-idem-001")),
                created_at: Date.now(),
            };

            // First upload
            const res1 = await fetch(`http://localhost:${edgePort}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ events: [event] }),
            });
            const body1 = await res1.json();
            assert.equal(body1.new_count, 1);

            // Retry (mule timed out, retries)
            const res2 = await fetch(`http://localhost:${edgePort}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ events: [event] }),
            });
            const body2 = await res2.json();
            assert.equal(body2.new_count, 0);
            assert.equal(body2.duplicate_count, 1);

            // Still only 1 incident
            const incidents = await edgeDb.getIncidents();
            assert.equal(incidents.length, 1);
        } finally {
            edgeServer.close();
        }
    });

    test("cluster recalculation from incidents", async () => {
        const { server: edgeServer, db: edgeDb } = createEdgeSync();
        const { server: ccServer, db: ccDb } = createCommandCenter();
        ccDb.edgeSyncClient = {
            getIncidents: async () => edgeDb.getIncidents(),
            emitAssign: async () => ({}),
        };

        const edgePort = await listen(edgeServer);
        const ccPort = await listen(ccServer);

        try {
            // Ingest 3 nearby incidents
            const now = Date.now();
            await fetch(`http://localhost:${edgePort}/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    events: [
                        {
                            id: "c-e1", incident_id: "c-inc-1", origin_node_id: "dev-1", seq: 1,
                            event_type_code: EVENT_TYPE.SOS_CREATED, actor_role_code: 1,
                            latitude: 6.9271, longitude: 79.8612, severity_level: 3,
                            hlc_timestamp: formatHlc(now, 1, nodeSlot("dev-1")), created_at: now,
                        },
                        {
                            id: "c-e2", incident_id: "c-inc-2", origin_node_id: "dev-2", seq: 1,
                            event_type_code: EVENT_TYPE.SOS_CREATED, actor_role_code: 1,
                            latitude: 6.9275, longitude: 79.8615, severity_level: 2,
                            hlc_timestamp: formatHlc(now + 100, 1, nodeSlot("dev-2")), created_at: now,
                        },
                        {
                            id: "c-e3", incident_id: "c-inc-3", origin_node_id: "dev-3", seq: 1,
                            event_type_code: EVENT_TYPE.SOS_CREATED, actor_role_code: 1,
                            latitude: 7.0000, longitude: 80.0000, severity_level: 1,
                            hlc_timestamp: formatHlc(now + 200, 1, nodeSlot("dev-3")), created_at: now,
                        },
                    ],
                }),
            });

            // Login as commander
            const loginRes = await fetch(`http://localhost:${ccPort}/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: "anjali@meshsync.lk", password: "demo1234" }),
            });
            const loginBody = await loginRes.json();
            const token = loginBody.token;

            // Recalculate clusters
            const res = await fetch(`http://localhost:${ccPort}/clusters/recalculate`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.ok(body.clusters.length >= 1);
            const bigCluster = body.clusters.find((c) => c.incident_count === 2);
            assert.ok(bigCluster, "should have a cluster with 2 nearby incidents");
        } finally {
            edgeServer.close();
            ccServer.close();
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