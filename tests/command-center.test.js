import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CommandCenterDb } from "../src/db.js";
import { createServer } from "../src/server.js";
import { CLEARANCE } from "@meshsync/shared/enums";

describe("Command Center — Auth", () => {
  test("authenticate with valid credentials returns token", () => {
    const db = new CommandCenterDb();
    const result = db.authenticate("anjali@meshsync.lk", "demo1234");
    assert.ok(result);
    assert.ok(result.token);
    assert.equal(result.user.username, "anjali@meshsync.lk");
    assert.equal(result.user.clearance_level, CLEARANCE.COMMANDER);
  });

  test("authenticate with invalid credentials returns null", () => {
    const db = new CommandCenterDb();
    const result = db.authenticate("anjali@meshsync.lk", "wrong");
    assert.equal(result, null);
  });

  test("authenticate with inactive user returns null", () => {
    const db = new CommandCenterDb();
    const user = db.getUsers().find((u) => u.username === "anjali@meshsync.lk");
    db.updateUser(user.id, { is_active: false });
    const result = db.authenticate("anjali@meshsync.lk", "demo1234");
    assert.equal(result, null);
  });

  test("getUserByToken returns user for valid token", () => {
    const db = new CommandCenterDb();
    const { token } = db.authenticate("anjali@meshsync.lk", "demo1234");
    const user = db.getUserByToken(token);
    assert.ok(user);
    assert.equal(user.username, "anjali@meshsync.lk");
  });

  test("getUserByToken returns null for invalid token", () => {
    const db = new CommandCenterDb();
    const user = db.getUserByToken("invalid-token");
    assert.equal(user, null);
  });

  test("createUser adds new user", () => {
    const db = new CommandCenterDb();
    const user = db.createUser({
      username: "newuser@test.lk",
      password: "pass123",
      full_name: "New User",
      clearance_level: CLEARANCE.DISPATCHER,
    });
    assert.ok(user.id);
    assert.equal(user.username, "newuser@test.lk");
    assert.equal(user.clearance_level, CLEARANCE.DISPATCHER);
  });
});

describe("Command Center — Zones", () => {
  test("createZone adds a zone", () => {
    const db = new CommandCenterDb();
    const zone = db.createZone({ area_name: "Test Zone" });
    assert.ok(zone.id);
    assert.equal(zone.area_name, "Test Zone");
  });

  test("getZones returns all zones", () => {
    const db = new CommandCenterDb();
    assert.ok(db.getZones().length >= 5); // seeded zones
  });

  test("updateZone updates a zone", () => {
    const db = new CommandCenterDb();
    const zone = db.createZone({ area_name: "Original" });
    const updated = db.updateZone(zone.id, { area_name: "Updated" });
    assert.equal(updated.area_name, "Updated");
  });

  test("deleteZone removes a zone", () => {
    const db = new CommandCenterDb();
    const zone = db.createZone({ area_name: "ToDelete" });
    assert.ok(db.deleteZone(zone.id));
    assert.equal(db.getZones().find((z) => z.id === zone.id), undefined);
  });
});

describe("Command Center — Clusters", () => {
  test("recalculateClusters groups nearby incidents", () => {
    const db = new CommandCenterDb();
    const incidents = [
      { id: "inc-1", latitude: 6.9271, longitude: 79.8612, status_code: 1, severity_level: 3 },
      { id: "inc-2", latitude: 6.9275, longitude: 79.8615, status_code: 1, severity_level: 2 }, // ~50m away
      { id: "inc-3", latitude: 7.0000, longitude: 80.0000, status_code: 1, severity_level: 1 }, // far away
    ];
    const clusters = db.recalculateClusters(incidents, 1000);
    assert.ok(clusters.length >= 1);
    const bigCluster = clusters.find((c) => c.incident_count === 2);
    assert.ok(bigCluster, "should have a cluster with 2 incidents");
    assert.ok(bigCluster.radius_meters > 0);
    assert.ok(bigCluster.centroid_lat > 0);
  });

  test("resolveCluster marks cluster as resolved", () => {
    const db = new CommandCenterDb();
    const cluster = db.createCluster({ centroid_lat: 6.9, centroid_lng: 79.8, incident_count: 3 });
    const resolved = db.resolveCluster(cluster.id, "admin-001");
    assert.equal(resolved.status, "RESOLVED");
    assert.equal(resolved.resolved_by_admin_id, "admin-001");
    assert.ok(resolved.resolved_at);
  });
});

describe("Command Center — Squads", () => {
  test("createSquad adds a squad", () => {
    const db = new CommandCenterDb();
    const user = db.getUsers()[0];
    const squad = db.createSquad({ squad_name: "Alpha Team", leader_authority_user_id: user.id });
    assert.ok(squad.id);
    assert.equal(squad.squad_name, "Alpha Team");
    assert.equal(squad.leader_authority_user_id, user.id);
  });

  test("addSquadMember adds a member", () => {
    const db = new CommandCenterDb();
    const users = db.getUsers();
    const squad = db.createSquad({ squad_name: "Bravo Team", leader_authority_user_id: users[0].id });
    const member = db.addSquadMember({ squad_id: squad.id, authority_user_id: users[1].id, role_in_squad: "MEDIC" });
    assert.ok(member);
    assert.equal(member.role_in_squad, "MEDIC");
  });

  test("addSquadMember rejects duplicate (UNIQUE constraint)", () => {
    const db = new CommandCenterDb();
    const users = db.getUsers();
    const squad = db.createSquad({ squad_name: "Charlie Team", leader_authority_user_id: users[0].id });
    db.addSquadMember({ squad_id: squad.id, authority_user_id: users[1].id });
    const dup = db.addSquadMember({ squad_id: squad.id, authority_user_id: users[1].id });
    assert.equal(dup, null);
  });

  test("getSquadMembers returns active members", () => {
    const db = new CommandCenterDb();
    const users = db.getUsers();
    const squad = db.createSquad({ squad_name: "Delta Team", leader_authority_user_id: users[0].id });
    db.addSquadMember({ squad_id: squad.id, authority_user_id: users[1].id, role_in_squad: "MEDIC" });
    db.addSquadMember({ squad_id: squad.id, authority_user_id: users[2].id, role_in_squad: "DRIVER" });
    const members = db.getSquadMembers(squad.id);
    assert.equal(members.length, 2);
  });

  test("removeSquadMember deactivates a member", () => {
    const db = new CommandCenterDb();
    const users = db.getUsers();
    const squad = db.createSquad({ squad_name: "Echo Team", leader_authority_user_id: users[0].id });
    const member = db.addSquadMember({ squad_id: squad.id, authority_user_id: users[1].id });
    db.removeSquadMember(member.id);
    const active = db.getSquadMembers(squad.id);
    assert.equal(active.length, 0);
  });

  test("deleteSquad also deletes members", () => {
    const db = new CommandCenterDb();
    const users = db.getUsers();
    const squad = db.createSquad({ squad_name: "Foxtrot Team", leader_authority_user_id: users[0].id });
    db.addSquadMember({ squad_id: squad.id, authority_user_id: users[1].id });
    db.deleteSquad(squad.id);
    assert.equal(db.getSquadById(squad.id), null);
    assert.equal(db.getSquadMembers(squad.id).length, 0);
  });
});

describe("Command Center — Devices", () => {
  test("registerDevice adds a device", () => {
    const db = new CommandCenterDb();
    const user = db.getUsers()[0];
    const device = db.registerDevice({ node_id: "device-001", authority_user_id: user.id });
    assert.ok(device.id);
    assert.equal(device.node_id, "device-001");
    assert.equal(device.is_active, true);
  });

  test("getActiveDeviceForUser returns most recent active device", () => {
    const db = new CommandCenterDb();
    const user = db.getUsers()[0];
    const d1 = db.registerDevice({ node_id: "device-old", authority_user_id: user.id });
    d1.last_seen_at = new Date(Date.now() - 60000).toISOString();
    const d2 = db.registerDevice({ node_id: "device-new", authority_user_id: user.id });
    const active = db.getActiveDeviceForUser(user.id);
    assert.equal(active.node_id, "device-new");
  });

  test("revokeDevice deactivates a device", () => {
    const db = new CommandCenterDb();
    const user = db.getUsers()[0];
    const device = db.registerDevice({ node_id: "device-002", authority_user_id: user.id });
    db.revokeDevice(device.id);
    const active = db.getActiveDeviceForUser(user.id);
    assert.equal(active, null);
  });
});

describe("Command Center — Dispatch", () => {
  test("dispatchResponder emits ASSIGN event via Edge Sync", async () => {
    const db = new CommandCenterDb();
    const user = db.getUsers()[0];
    db.registerDevice({ node_id: "device-dispatch", authority_user_id: user.id });

    let emittedAssign = null;
    db.edgeSyncClient = {
      emitAssign: async (payload) => {
        emittedAssign = payload;
        return { id: "assign-001", ...payload, origin_node_id: "CLOUD-0000" };
      },
    };

    const zone = db.getZones()[0];
    const result = await db.dispatchResponder({
      authority_user_id: user.id,
      zone_id: zone.id,
      admin_id: "admin-001",
    });

    assert.ok(result.event);
    assert.equal(emittedAssign.target_node_id, "device-dispatch");
    assert.equal(emittedAssign.target_zone_id, zone.id);
  });

  test("dispatchResponder fails if no active device", async () => {
    const db = new CommandCenterDb();
    db.edgeSyncClient = { emitAssign: async () => ({}) };
    const result = await db.dispatchResponder({
      authority_user_id: "nonexistent",
      zone_id: "zone-1",
    });
    assert.ok(result.error);
  });

  test("dispatchSquad emits N ASSIGN events for N members", async () => {
    const db = new CommandCenterDb();
    const users = db.getUsers();
    const squad = db.createSquad({ squad_name: "Dispatch Squad", leader_authority_user_id: users[0].id });
    db.addSquadMember({ squad_id: squad.id, authority_user_id: users[1].id, role_in_squad: "MEDIC" });
    db.addSquadMember({ squad_id: squad.id, authority_user_id: users[2].id, role_in_squad: "DRIVER" });
    db.registerDevice({ node_id: "dev-1", authority_user_id: users[1].id });
    db.registerDevice({ node_id: "dev-2", authority_user_id: users[2].id });

    let emitCount = 0;
    db.edgeSyncClient = {
      emitAssign: async (payload) => {
        emitCount++;
        return { id: `assign-${emitCount}`, ...payload };
      },
    };

    const zone = db.getZones()[0];
    const result = await db.dispatchSquad({ squad_id: squad.id, zone_id: zone.id });
    assert.equal(emitCount, 2);
    assert.equal(result.results.length, 2);
  });
});

describe("Command Center — HTTP server", () => {
  test("GET /health returns ok", async () => {
    const { server } = createServer();
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

  test("POST /auth/login with valid credentials returns token", async () => {
    const { server } = createServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "anjali@meshsync.lk", password: "demo1234" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.token);
      assert.equal(body.user.username, "anjali@meshsync.lk");
    } finally {
      server.close();
    }
  });

  test("POST /auth/login with invalid credentials returns 401", async () => {
    const { server } = createServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "anjali@meshsync.lk", password: "wrong" }),
      });
      assert.equal(res.status, 401);
    } finally {
      server.close();
    }
  });

  test("GET /zones returns seeded zones", async () => {
    const { server } = createServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/zones`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.zones.length >= 5);
    } finally {
      server.close();
    }
  });

  test("GET /squads returns squads list", async () => {
    const { server } = createServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/squads`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.squads);
    } finally {
      server.close();
    }
  });

  test("GET /satellite returns uplinks", async () => {
    const { server } = createServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://localhost:${port}/satellite`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.uplinks.length >= 3);
    } finally {
      server.close();
    }
  });

  test("POST /squads creates a squad", async () => {
    const { server, db } = createServer();
    const port = await listen(server);
    try {
      const user = db.getUsers()[0];
      const res = await fetch(`http://localhost:${port}/squads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ squad_name: "HTTP Squad", leader_authority_user_id: user.id }),
      });
      const body = await res.json();
      assert.equal(res.status, 201);
      assert.equal(body.squad_name, "HTTP Squad");
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
