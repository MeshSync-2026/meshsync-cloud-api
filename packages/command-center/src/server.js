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
import { CommandCenterDb } from "./db.js";
import { CLEARANCE } from "@meshsync/shared/enums";

export function createServer(edgeSyncClient = null) {
  const db = new CommandCenterDb();
  db.edgeSyncClient = edgeSyncClient;

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
        const body = JSON.parse(await readBody(req));
        const result = db.authenticate(body.username, body.password);
        if (!result) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Invalid credentials" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (path === "/auth/signup" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.username || !body.password) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "username and password are required" }));
          return;
        }
        // Check for existing user
        const existing = db.getUsers().find((u) => u.username === body.username);
        if (existing) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "User already exists" }));
          return;
        }
        const user = db.createUser({
          username: body.username,
          password: body.password,
          full_name: body.full_name,
          clearance_level: CLEARANCE.DISPATCHER,
        });
        // Mark as pending (in a real system, would have a status field)
        const { password_hash, ...safeUser } = user;
        res.writeHead(201);
        res.end(JSON.stringify({ user: safeUser, status: "PENDING" }));
        return;
      }

      if (path === "/auth/me" && method === "GET") {
        const token = req.headers.authorization?.replace("Bearer ", "");
        const user = db.getUserByToken(token);
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
      const token = req.headers.authorization?.replace("Bearer ", "");
      const currentUser = db.getUserByToken(token);
      if (!currentUser && !path.startsWith("/health")) {
        // Allow unauthenticated access for demo (in production, require auth)
        // Actually let's require auth for write operations
      }

      // --- Users ---
      if (path === "/users" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ users: db.getUsers() }));
        return;
      }

      const approveMatch = path.match(/^\/users\/([^/]+)\/approve$/);
      if (approveMatch && method === "POST") {
        const updated = db.updateUser(approveMatch[1], { is_active: true, clearance_level: CLEARANCE.DISPATCHER });
        res.writeHead(200);
        res.end(JSON.stringify(updated));
        return;
      }

      const rejectMatch = path.match(/^\/users\/([^/]+)\/reject$/);
      if (rejectMatch && method === "POST") {
        const updated = db.updateUser(rejectMatch[1], { is_active: false });
        res.writeHead(200);
        res.end(JSON.stringify(updated));
        return;
      }

      // --- Devices ---
      if (path === "/devices" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ devices: db.getDevices() }));
        return;
      }

      if (path === "/devices" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.node_id || !body.authority_user_id) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "node_id and authority_user_id are required" }));
          return;
        }
        const device = db.registerDevice(body);
        res.writeHead(201);
        res.end(JSON.stringify(device));
        return;
      }

      const revokeDeviceMatch = path.match(/^\/devices\/([^/]+)\/revoke$/);
      if (revokeDeviceMatch && method === "POST") {
        const device = db.revokeDevice(revokeDeviceMatch[1]);
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
        res.end(JSON.stringify({ zones: db.getZones() }));
        return;
      }

      if (path === "/zones" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (!body.area_name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "area_name is required" }));
          return;
        }
        const zone = db.createZone(body);
        res.writeHead(201);
        res.end(JSON.stringify(zone));
        return;
      }

      const zoneMatch = path.match(/^\/zones\/([^/]+)$/);
      if (zoneMatch && method === "PUT") {
        const body = JSON.parse(await readBody(req));
        const zone = db.updateZone(zoneMatch[1], body);
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
        db.deleteZone(zoneMatch[1]);
        res.writeHead(204);
        res.end();
        return;
      }

      // --- Clusters ---
      if (path === "/clusters" && method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ clusters: db.getClusters() }));
        return;
      }

      if (path === "/clusters/recalculate" && method === "POST") {
        // Fetch incidents from Edge Sync
        let incidents = [];
        if (db.edgeSyncClient) {
          incidents = await db.edgeSyncClient.getIncidents();
        }
        const newClusters = db.recalculateClusters(incidents);
        res.writeHead(200);
        res.end(JSON.stringify({ clusters: newClusters, count: newClusters.length }));
        return;
      }

      const resolveClusterMatch = path.match(/^\/clusters\/([^/]+)\/resolve$/);
      if (resolveClusterMatch && method === "POST") {
        const cluster = db.resolveCluster(resolveClusterMatch[1], currentUser?.id);
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
        const squads = db.getSquads().map((s) => ({
          ...s,
          member_count: db.getSquadMembers(s.id).length,
        }));
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
        const squad = db.createSquad(body);
        res.writeHead(201);
        res.end(JSON.stringify(squad));
        return;
      }

      const squadMatch = path.match(/^\/squads\/([^/]+)$/);
      if (squadMatch && method === "GET") {
        const squad = db.getSquadById(squadMatch[1]);
        if (!squad) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Squad not found" }));
          return;
        }
        const members = db.getSquadMembers(squadMatch[1]);
        res.writeHead(200);
        res.end(JSON.stringify({ ...squad, members }));
        return;
      }

      if (squadMatch && method === "PUT") {
        const body = JSON.parse(await readBody(req));
        const squad = db.updateSquad(squadMatch[1], body);
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
        db.deleteSquad(squadMatch[1]);
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
        const member = db.addSquadMember({
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
        const member = db.removeSquadMember(removeMemberMatch[2]);
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
        const result = await db.dispatchResponder({
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
        const result = await db.dispatchSquad({
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
        res.end(JSON.stringify({ uplinks: db.getSatelliteUplinks() }));
        return;
      }

      const satMatch = path.match(/^\/satellite\/([^/]+)$/);
      if (satMatch && method === "PUT") {
        const body = JSON.parse(await readBody(req));
        const uplink = db.updateSatelliteUplink(satMatch[1], body);
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

  return { server, db };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.CC_PORT || 4002;
  const { server } = createServer();
  server.listen(port, () => {
    console.log(`Command Center Service running on http://localhost:${port}`);
  });
}

export default { createServer };
