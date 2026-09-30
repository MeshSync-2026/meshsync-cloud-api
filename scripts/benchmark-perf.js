// Performance benchmark — Test Plan §3.1.4
// 1) Clustering O(n^2) scaling: 100 / 500 / 1000 active incidents
// 2) /ingest batch timing vs the < 2s target (1,000 events), local + live Render
//
// Run: node scripts/benchmark-perf.js [--live <url>]

import { performance } from "node:perf_hooks";
import { clusterIncidents } from "../packages/command-center/src/spatial.js";

function makeIncident(i) {
  // Spread over ~10km box around Colombo so clusters actually form
  return {
    id: `inc-${i}`,
    latitude: 6.85 + (i % 100) * 0.002,
    longitude: 79.85 + Math.floor(i / 100) * 0.002,
    severity_level: (i % 3) + 1,
    status_code: 1,
  };
}

function benchCluster(n) {
  const incidents = Array.from({ length: n }, (_, i) => makeIncident(i));
  const t0 = performance.now();
  const clusters = clusterIncidents(incidents, 1000);
  const ms = performance.now() - t0;
  console.log(`  clusterIncidents n=${n.toString().padStart(4)} -> ${ms.toFixed(1)} ms  (${clusters.length} clusters)`);
  return ms;
}

function makeEvent(i, node = "bench-node") {
  // Minimal valid STATUS_UPDATE per packages/shared/src/validation.js
  const seq = i + 1;
  return {
    id: `bench-${node}-${i}`,
    hlc_timestamp: `1790750000000-${String(seq).padStart(5, "0")}-${node.slice(0, 8)}`,
    origin_node_id: node,
    event_type_code: 3,
    schema_version: 1,
    created_at: 1790750000000 + i,
    seq,
    incident_id: `bench-${node}-${i}`,
    category_code: 0,
    report_type_code: 1,
    severity_code: 0,
    water_level: 0,
    needs_rescue: false,
    people_count: 1,
    resource_need_code: 0,
    medical_need_code: 0,
    visibility_flag: true,
    status_text: "benchmark event",
    tags: [],
    battery_pct: 50,
  };
}

async function benchIngest(url, count) {
  const events = Array.from({ length: count }, (_, i) => makeEvent(i));
  const body = JSON.stringify({ uploading_node_id: "bench-node", events });
  console.log(`  POST /ingest (${count} events, ${(body.length / 1024).toFixed(0)} KB) -> ${url}`);
  const t0 = performance.now();
  const res = await fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const ms = performance.now() - t0;
  const json = await res.json().catch(() => ({}));
  console.log(`    HTTP ${res.status} in ${ms.toFixed(0)} ms  new=${json.new_count} dup=${json.duplicate_count} rej=${json.rejected_count}`);
  return ms;
}

(async () => {
  console.log("=== MeshSync Performance Benchmark ===\n");
  console.log("[1] Clustering scaling (local, Node " + process.version + ")");
  for (const n of [100, 500, 1000]) benchCluster(n);

  const live = process.argv[process.argv.indexOf("--live") + 1] || process.env.EDGE_URL;
  if (live && live.startsWith("http")) {
    console.log(`\n[2] Ingest timing vs ${live} (Render free tier: 0.1 CPU / 512MB)`);
    for (const count of [100, 1000]) await benchIngest(live, count);
    // duplicate re-push — idempotency check
    await benchIngest(live, 100);
  } else {
    console.log("\n[2] Skipped remote ingest (pass --live <url>)");
  }
})();
