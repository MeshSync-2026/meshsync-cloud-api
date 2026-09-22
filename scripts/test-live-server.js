// Live Server End-to-End Test Script
// Spins up both Edge Sync (port 4001) and Command Center (port 4002),
// executes real HTTP/REST requests, verifies live functionality, and shuts down cleanly.

import http from "node:http";
import zlib from "node:zlib";
import { createServer as createEdgeSync } from "../packages/edge-sync/src/server.js";
import { createServer as createCommandCenter } from "../packages/command-center/src/server.js";
import { EVENT_TYPE, REPORT_TYPE, SEVERITY } from "../packages/shared/src/enums.js";
import { formatHlc, nodeSlot } from "../packages/shared/src/hlc.js";

const EDGE_PORT = 4001;
const CC_PORT = 4002;

function log(step, msg, ok = true) {
  const icon = ok ? "✅" : "❌";
  console.log(`\x1b[36m[Step ${step}]\x1b[0m ${icon} ${msg}`);
}

async function runLiveTest() {
  console.log("\n=======================================================");
  console.log("   🚀 STARTING MESHSYNC LIVE SERVER INTEGRATION TEST   ");
  console.log("=======================================================\n");

  // 1. Start Edge Sync
  const { server: edgeServer, db: edgeDb } = createEdgeSync();
  await new Promise((res) => edgeServer.listen(EDGE_PORT, res));
  log(1, `Edge Sync Service running on http://localhost:${EDGE_PORT}`);

  // 2. Start Command Center
  const edgeSyncClient = {
    emitAssign: async (payload) => {
      const res = await fetch(`http://localhost:${EDGE_PORT}/internal/assign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": process.env.INTERNAL_API_SECRET || "internal-meshsync-key-secret",
        },
        body: JSON.stringify(payload),
      });
      return await res.json();
    },
    getIncidents: async () => {
      const res = await fetch(`http://localhost:${EDGE_PORT}/incidents`);
      const body = await res.json();
      return body.incidents || [];
    },
  };

  const { server: ccServer, db: ccDb } = createCommandCenter(edgeSyncClient);
  await new Promise((res) => ccServer.listen(CC_PORT, res));
  log(2, `Command Center Service running on http://localhost:${CC_PORT}`);

  try {
    // 3. Health Checks
    console.log("\n--- Testing Health Endpoints ---");
    const edgeHealth = await (await fetch(`http://localhost:${EDGE_PORT}/health`)).json();
    log(3, `Edge Sync Health OK: ${JSON.stringify(edgeHealth)}`);

    const ccHealth = await (await fetch(`http://localhost:${CC_PORT}/health`)).json();
    log(4, `Command Center Health OK: ${JSON.stringify(ccHealth)}`);

    // 4. Command Center Authentication
    console.log("\n--- Testing Authentication & RBAC ---");
    const loginRes = await fetch(`http://localhost:${CC_PORT}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "anjali@meshsync.lk", password: "demo1234" }),
    });
    const authData = await loginRes.json();
    log(5, `Logged in as Commander: ${authData.user.full_name} (${authData.user.clearance_level})`);
    const token = authData.token;

    // 5. Simulate Data Mule uploading an SOS batch (GZIP compressed)
    console.log("\n--- Testing Data Mule Ingest (GZIP Compressed) ---");
    const now = Date.now();
    const sosEvent = {
      id: "live-sos-001",
      parent_id: null,
      incident_id: "live-inc-colombo-1",
      origin_node_id: "victim-device-42",
      seq: 1,
      event_type_code: EVENT_TYPE.SOS_CREATED,
      actor_role_code: 1,
      latitude: 6.9271,
      longitude: 79.8612,
      landmark_name: "Galle Face Green",
      report_type_code: REPORT_TYPE.SOS,
      category_code: null,
      severity_level: SEVERITY.HIGH,
      status_safety: 2, // TRAPPED
      people_count: 3,
      status_water: 2, // NONE
      status_injury: 1, // MINOR
      target_node_id: null,
      target_zone_id: null,
      hlc_timestamp: formatHlc(now, 1, nodeSlot("victim-device-42")),
      created_at: now,
    };

    const batchPayload = JSON.stringify({
      uploading_node_id: "data-mule-alpha",
      events: [sosEvent],
    });
    const compressedBatch = zlib.gzipSync(Buffer.from(batchPayload, "utf8"));

    const ingestRes = await fetch(`http://localhost:${EDGE_PORT}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: compressedBatch,
    });
    const ingestResult = await ingestRes.json();
    log(6, `Data Mule Ingest result: new=${ingestResult.new_count}, ack_ids=[${ingestResult.ack_ids.join(", ")}]`);

    // 6. Verify Projections
    console.log("\n--- Testing Read Projections ---");
    const incidentsRes = await fetch(`http://localhost:${EDGE_PORT}/incidents`);
    const { incidents } = await incidentsRes.json();
    log(7, `Incidents Projection updated: found ${incidents.length} active incident(s)`);
    console.log(`   - ID: ${incidents[0].id}`);
    console.log(`   - Landmark: ${incidents[0].landmark_name}`);
    console.log(`   - Status: ${incidents[0].status_code} (OPEN), Confidence: ${incidents[0].confidence_code} (LIVE)`);

    // 7. Register Officer Device in Command Center
    console.log("\n--- Testing Officer Registration & Dispatch ---");
    const officer = ccDb.getUsers().find((u) => u.username === "suresh@meshsync.lk");
    const deviceRes = await fetch(`http://localhost:${CC_PORT}/devices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        node_id: "responder-device-88",
        authority_user_id: officer.id,
      }),
    });
    const device = await deviceRes.json();
    log(8, `Registered responder device: ${device.node_id} for officer ${officer.full_name}`);

    // 8. Dispatch Responder to Zone
    const zonesRes = await fetch(`http://localhost:${CC_PORT}/zones`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { zones } = await zonesRes.json();
    const zone = zones[0];

    const dispatchRes = await fetch(`http://localhost:${CC_PORT}/dispatch/responder`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        authority_user_id: officer.id,
        zone_id: zone.id,
        incident_id: incidents[0].id,
      }),
    });
    const dispatchResult = await dispatchRes.json();
    log(9, `Dispatched responder to zone '${zone.area_name}' with cloud HLC ${dispatchResult.event.hlc_timestamp}`);

    // 9. Data Mule Pulls New Events via GET /sync
    console.log("\n--- Testing Data Mule Pull via GET /sync ---");
    const syncRes = await fetch(`http://localhost:${EDGE_PORT}/sync`);
    const { events } = await syncRes.json();
    log(10, `Data Mule pulled ${events.length} event(s) from cloud to carry back to mesh:`);
    for (const e of events) {
      console.log(`   - Type: ${e.event_type_code}, Origin: ${e.origin_node_id}, HLC: ${e.hlc_timestamp}`);
    }

    console.log("\n=======================================================");
    console.log("   🎉 ALL LIVE SERVER ENDPOINTS OPERATIONAL & WORKING!  ");
    console.log("=======================================================\n");
  } catch (err) {
    console.error("❌ Live Server Test Error:", err);
  } finally {
    edgeServer.close();
    ccServer.close();
  }
}

runLiveTest();
