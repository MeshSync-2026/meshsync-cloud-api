// Command Center Service — HTTP server
// Architecture Plan §10.5.2
//
// Endpoints:
//   POST /auth/login           — authenticate, get session token
//   POST /auth/signup          — request access (creates PENDING user)
//   GET  /auth/me              — get current user from token
//   GET  /users                — list users (COMMANDER only)
//   POST /users/:id/approve    — approve a pending user (COMMANDER only)
//   POST /users/:id/reject     — reject a pending user (COMMANDER only)
//   GET  /devices              — list registered devices
//   POST /devices              — register a device
//   POST /devices/:id/revoke   — revoke a device
//   GET  /zones                — list zones
//   POST /zones                — create zone
//   PUT  /zones/:id            — update zone
//   DELETE /zones/:id          — delete zone
//   GET  /clusters             — list clusters
//   POST /clusters/recalculate — recalculate clusters from incidents
//   POST /clusters/:id/resolve — resolve a cluster (COMMANDER only)
//   GET  /squads               — list squads
//   POST /squads               — create squad
//   GET  /squads/:id           — get squad with members
//   PUT  /squads/:id           — update squad
//   DELETE /squads/:id         — delete squad
//   POST /squads/:id/members   — add member to squad
//   DELETE /squads/:id/members/:memberId — remove member
//   POST /dispatch/responder   — dispatch a single responder
//   POST /dispatch/squad       — dispatch an entire squad
//   GET  /satellite            — list satellite uplinks
//   PUT  /satellite/:id        — update uplink status
//   GET  /health               — health check

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDb, InMemoryDb, PostgresDb } from "./db.js";
import { CLEARANCE } from "@meshsync/shared/enums";

function createHttpEdgeSyncClient(edgeSyncUrl, internalToken) {
  return {
    async emitAssign(payload) {
      const res = await fetch(`${edgeSyncUrl}/internal/assign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": internalToken || "",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Edge Sync assign error (${res.status}): ${errText}`);
      }
      return await res.json();
    },
    async getIncidents() {
      const res = await fetch(`${edgeSyncUrl}/incidents`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.incidents || [];
    },
  };
}

export function createServer(edgeSyncClient = null, db = null) {
  let database = db;
  if (!database) {
    if (process.env.DATABASE_URL) {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      database = createDb(true, pool);
    } else {
      database = createDb(false);
    }
  }

  const client = edgeSyncClient || (process.env.EDGE_SYNC_URL ? createHttpEdgeSyncClient(process.env.EDGE_SYNC_URL, process.env.INTERNAL_API_SECRET) : null);
  database.edgeSyncClient = client;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      const method = req.method;

      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      res.setHeader("Content-Type", "application/json");

      // --- Health ---
      if (path === "/health" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", service: "command-center", timestamp: Date.now() }));
        return;
      }

      // --- Auth ---
      if (path === "/auth/login" && method === "POST") {
        const rawBody = await readBody(req);
        let body;
        try {
          body = JSON.parse(rawBody);
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const result = await database.authenticate(body.username, body.password);
        if (!result) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Invalid credentials" }));
          return;
        }
        if (result.error === "pending") {
          res.writeHead(403);
          res.end(JSON.stringify({ error: result.message || "Account is pending commander approval" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (path === "/auth/signup" && method === "POST") {
        const rawBody = await readBody(req);
        let body;
        try {
          body = JSON.parse(rawBody);
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        if (!body.username || !body.password) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "username and password are required" }));
          return;
        }
        // Check for existing user
        const existing = (await database.getUsers()).find((u) => u.username === body.username);
        if (existing) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "User already exists" }));
          return;
        }
        const user = await database.createUser({
          username: body.username,
          password: body.password,
          full_name: body.full_name,
          clearance_level: CLEARANCE.DISPATCHER,
          is_active: false,
        });
        const { password_hash, ...safeUser } = user;
        res.writeHead(201);
        res.end(JSON.stringify({ user: safeUser, status: "PENDING" }));
        return;
      }

      if (path === "/auth/me" && method === "GET") {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
        const user = token ? await database.getUserByToken(token) : null;
        if (!user) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Not authenticated" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(user));
        return;
      }

      // Auth middleware for remaining endpoints
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
      const currentUser = token ? await database.getUserByToken(token) : null;

      const isPublicRoute = path === "/health" || path === "/auth/login" || path === "/auth/signup";
      if (!isPublicRoute && !currentUser) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Authentication required. Please provide a valid Bearer token." }));
        return;
      }

      function requireCommander() {
        if (!currentUser) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Authentication required" }));
          return false;
        }
        if (currentUser.clearance_level !== CLEARANCE.COMMANDER) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: "Forbidden: Commander clearance required" }));
          return false;
        }
        return true;
      }

      // --- Users (COMMANDER only) ---
      if (path === "/users" && method === "GET") {
        if (!requireCommander()) return;
        res.writeHead(200);
        res.end(JSON.stringify({ users: await database.getUsers() }));
        return;
      }

      const approveMatch = path.match(/^\/users\/([^/]+)\/approve$/);
      if (approveMatch && method === "POST") {
        if (!requireCommander()) return;
        const updated = await database.updateUser(approveMatch[1], { is_active: true, clearance_level: CLEARANCE.DISPATCHER });
        res.writeHead(200);
        res.end(JSON.stringify(updated));
        return;
      }

      const rejectMatch = path.match(/^\/users\/([^/]+)\/reject$/);
      if (rejectMatch && method === "POST") {
        if (!requireCommander()) return;
        const updated = await database.updateUser(rejectMatch[1], { is_active: false });
        res.writeHead(200);
        res.end(JSON.stringify(updated));
        return;
      }

      // --- Devices ---
      if (path === "/devices" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ devices: await database.getDevices() }));
        return;
      }

      if (path === "/devices" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.node_id || !body.authority_user_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "node_id and authority_user_id are required" }));
          return;
        }
        const device = await database.registerDevice(body);
        res.writeHead(201);
        res.end(JSON.stringify(device));
        return;
      }

      // Device revocation (COMMANDER clearance required)
      const revokeDeviceMatch = path.match(/^\/devices\/([^/]+)\/revoke$/);
      if (revokeDeviceMatch && method === "POST") {
        if (!requireCommander()) return;
        const device = await database.revokeDevice(revokeDeviceMatch[1]);
        if (!device) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Device not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(device));
        return;
      }

      // --- Zones ---
      if (path === "/zones" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ zones: await database.getZones() }));
        return;
      }

      if (path === "/zones" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.area_name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "area_name is required" }));
          return;
        }
        const zone = await database.createZone(body);
        res.writeHead(201);
        res.end(JSON.stringify(zone));
        return;
      }

      const zoneMatch = path.match(/^\/zones\/([^/]+)$/);
      if (zoneMatch && method === "PUT") {
        const body = JSON.parse(await readBody(req));
        const zone = await database.updateZone(zoneMatch[1], body);
        if (!zone) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Zone not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(zone));
        return;
      }

      if (zoneMatch && method === "DELETE") {
        if (!requireCommander()) return;
        await database.deleteZone(zoneMatch[1]);
        res.writeHead(204);
        res.end();
        return;
      }

      // --- Clusters ---
      if (path === "/clusters" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ clusters: await database.getClusters() }));
        return;
      }

      if (path === "/clusters/recalculate" && method === "POST") {
        if (!requireCommander()) return;
        let incidents = [];
        if (database.edgeSyncClient) {
          incidents = await database.edgeSyncClient.getIncidents();
        }
        const newClusters = await database.recalculateClusters(incidents);
        res.writeHead(200);
        res.end(JSON.stringify({ clusters: newClusters, count: newClusters.length }));
        return;
      }

      // Cluster resolution (COMMANDER clearance required)
      const resolveClusterMatch = path.match(/^\/clusters\/([^/]+)\/resolve$/);
      if (resolveClusterMatch && method === "POST") {
        if (!requireCommander()) return;
        const cluster = await database.resolveCluster(resolveClusterMatch[1], currentUser?.id);
        if (!cluster) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Cluster not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(cluster));
        return;
      }

      // --- Squads ---
      if (path === "/squads" && method === "GET") {
        const rawSquads = await database.getSquads();
        const squads = await Promise.all(rawSquads.map(async (s) => ({
          ...s,
          member_count: (await database.getSquadMembers(s.id)).length,
        })));
        res.writeHead(200);
        res.end(JSON.stringify({ squads }));
        return;
      }

      if (path === "/squads" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.squad_name || !body.leader_authority_user_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "squad_name and leader_authority_user_id are required" }));
          return;
        }
        const squad = await database.createSquad(body);
        res.writeHead(201);
        res.end(JSON.stringify(squad));
        return;
      }

      const squadMatch = path.match(/^\/squads\/([^/]+)$/);
      if (squadMatch && method === "GET") {
        const squad = await database.getSquadById(squadMatch[1]);
        if (!squad) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Squad not found" }));
          return;
        }
        const members = await database.getSquadMembers(squadMatch[1]);
        res.writeHead(200);
        res.end(JSON.stringify({ ...squad, members }));
        return;
      }

      if (squadMatch && method === "PUT") {
        const body = JSON.parse(await readBody(req));
        const squad = await database.updateSquad(squadMatch[1], body);
        if (!squad) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Squad not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(squad));
        return;
      }

      if (squadMatch && method === "DELETE") {
        if (!requireCommander()) return;
        await database.deleteSquad(squadMatch[1]);
        res.writeHead(204);
        res.end();
        return;
      }

      const addMemberMatch = path.match(/^\/squads\/([^/]+)\/members$/);
      if (addMemberMatch && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.authority_user_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "authority_user_id is required" }));
          return;
        }
        const member = await database.addSquadMember({
          squad_id: addMemberMatch[1],
          authority_user_id: body.authority_user_id,
          role_in_squad: body.role_in_squad,
        });
        if (!member) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "Already a member" }));
          return;
        }
        res.writeHead(201);
        res.end(JSON.stringify(member));
        return;
      }

      const removeMemberMatch = path.match(/^\/squads\/([^/]+)\/members\/([^/]+)$/);
      if (removeMemberMatch && method === "DELETE") {
        const member = await database.removeSquadMember(removeMemberMatch[2]);
        if (!member) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Member not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(member));
        return;
      }

      // --- Dispatch ---
      if (path === "/dispatch/responder" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.authority_user_id || !body.zone_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "authority_user_id and zone_id are required" }));
          return;
        }
        const result = await database.dispatchResponder({
          authority_user_id: body.authority_user_id,
          zone_id: body.zone_id,
          incident_id: body.incident_id,
          admin_id: currentUser?.id,
        });
        if (result.error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (path === "/dispatch/squad" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.squad_id || !body.zone_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "squad_id and zone_id are required" }));
          return;
        }
        const result = await database.dispatchSquad({
          squad_id: body.squad_id,
          zone_id: body.zone_id,
          admin_id: currentUser?.id,
        });
        if (result.error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      // --- Satellite ---
      if (path === "/satellite" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ uplinks: await database.getSatelliteUplinks() }));
        return;
      }

      const satMatch = path.match(/^\/satellite\/([^/]+)$/);
      if (satMatch && method === "PUT") {
        const body = JSON.parse(await readBody(req));
        const uplink = await database.updateSatelliteUplink(satMatch[1], body);
        if (!uplink) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Uplink not found" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(uplink));
        return;
      }

      // --- 404 ---
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found", path }));
    } catch (err) {
      console.error("Command Center error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal server error", detail: err.message }));
    }
  });

  return { server, db: database };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = process.env.PORT || process.env.CC_PORT || 4002;
  const { server } = createServer();
  server.listen(port, () => {
    console.log(`Command Center Service running on http://localhost:${port}`);
  });
}

export default { createServer };
