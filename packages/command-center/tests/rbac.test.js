import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDb } from "../src/db.js";
import { createServer } from "../src/server.js";
import { CLEARANCE } from "@meshsync/shared/enums";
import { haversineDistance, sphericalCentroid, clusterIncidents } from "../src/spatial.js";

describe("Command Center — RBAC & Route Authorization", () => {
  test("DISPATCHER cannot revoke a device (403 Forbidden)", async () => {
    const { server, db } = createServer();
    const port = await listen(server);

    try {
      // Login as Dispatcher (Suresh)
      const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "suresh@meshsync.lk", password: "demo1234" }),
      });
      const { token } = await loginRes.json();
      assert.ok(token);

      // Register a device
      const user = db.getUsers()[0];
      const device = db.registerDevice({ node_id: "dev-revoke-test", authority_user_id: user.id });

      // Attempt to revoke with Dispatcher token
      const revokeRes = await fetch(`http://localhost:${port}/devices/${device.id}/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      assert.equal(revokeRes.status, 403);
      const errBody = await revokeRes.json();
      assert.ok(errBody.error.includes("Commander"));
    } finally {
      server.close();
    }
  });

  test("COMMANDER can successfully revoke a device (200 OK)", async () => {
    const { server, db } = createServer();
    const port = await listen(server);

    try {
      // Login as Commander (Anjali)
      const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "anjali@meshsync.lk", password: "demo1234" }),
      });
      const { token } = await loginRes.json();

      // Register a device
      const user = db.getUsers()[0];
      const device = db.registerDevice({ node_id: "dev-commander-revoke", authority_user_id: user.id });

      // Revoke with Commander token
      const revokeRes = await fetch(`http://localhost:${port}/devices/${device.id}/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      assert.equal(revokeRes.status, 200);
      const revoked = await revokeRes.json();
      assert.equal(revoked.is_active, false);
    } finally {
      server.close();
    }
  });

  test("DISPATCHER cannot resolve cluster (403 Forbidden)", async () => {
    const { server, db } = createServer();
    const port = await listen(server);

    try {
      const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "suresh@meshsync.lk", password: "demo1234" }),
      });
      const { token } = await loginRes.json();

      const cluster = db.createCluster({ centroid_lat: 6.9, centroid_lng: 79.8, incident_count: 2 });

      const resolveRes = await fetch(`http://localhost:${port}/clusters/${cluster.id}/resolve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(resolveRes.status, 403);
    } finally {
      server.close();
    }
  });

  test("COMMANDER can resolve cluster (200 OK)", async () => {
    const { server, db } = createServer();
    const port = await listen(server);

    try {
      const loginRes = await fetch(`http://localhost:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "anjali@meshsync.lk", password: "demo1234" }),
      });
      const { token } = await loginRes.json();

      const cluster = db.createCluster({ centroid_lat: 6.9, centroid_lng: 79.8, incident_count: 2 });

      const resolveRes = await fetch(`http://localhost:${port}/clusters/${cluster.id}/resolve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(resolveRes.status, 200);
      const body = await resolveRes.json();
      assert.equal(body.status, "RESOLVED");
    } finally {
      server.close();
    }
  });
});

describe("Command Center — Spatial Calculations", () => {
  test("haversineDistance calculates accurate distance", () => {
    // Distance between Colombo Fort (6.9344, 79.8428) and Galle Face (6.9271, 79.8436) ~ 820m
    const d = haversineDistance(6.9344, 79.8428, 6.9271, 79.8436);
    assert.ok(d > 750 && d < 900, `Expected ~820m, got ${d}`);
  });

  test("sphericalCentroid calculates true geometric center", () => {
    const points = [
      { latitude: 6.90, longitude: 79.80 },
      { latitude: 7.00, longitude: 80.00 },
    ];
    const centroid = sphericalCentroid(points);
    assert.ok(centroid.centroidLat > 6.94 && centroid.centroidLat < 6.96);
    assert.ok(centroid.centroidLng > 79.89 && centroid.centroidLng < 79.91);
  });

  test("clusterIncidents groups incidents within radius", () => {
    const incidents = [
      { id: "i1", latitude: 6.9271, longitude: 79.8612, status_code: 1, severity_level: 3 },
      { id: "i2", latitude: 6.9275, longitude: 79.8615, status_code: 1, severity_level: 2 },
      { id: "i3", latitude: 8.5000, longitude: 81.0000, status_code: 1, severity_level: 1 }, // isolated
    ];

    const clusters = clusterIncidents(incidents, 1000);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].incident_count, 2);
    assert.equal(clusters[0].severity_score, 3);
  });
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve(server.address().port);
    });
  });
}
