// Command Center Service — database
// Architecture Plan §10.5.2
//
// Owns writes to: CLUSTER, RESPONSE_ZONE, AUTHORITY_USER, REGISTERED_DEVICE,
// RESPONDER_SQUAD, SQUAD_MEMBER, SATELLITE_UPLINK
//
// Reads from: INCIDENT, MESH_EVENT, MESH_ASSIGNMENT (projections owned by Edge Sync)

import { createHash, randomUUID } from "node:crypto";
import { CLEARANCE } from "@meshsync/shared/enums";

// Simple bcrypt-like hash for demo (in production use real bcrypt)
function hashPassword(password) {
  return "demo$" + createHash("sha256").update(password).digest("hex");
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

// ============================================================================
// In-memory Command Center DB
// ============================================================================

export class CommandCenterDb {
  constructor() {
    this.users = new Map();           // id → user
    this.devices = new Map();         // id → device
    this.clusters = new Map();        // id → cluster
    this.zones = new Map();           // id → zone
    this.squads = new Map();          // id → squad
    this.squadMembers = new Map();    // id → member
    this.satelliteUplinks = new Map(); // id → uplink
    this.sessions = new Map();        // token → { userId, expiresAt }
    this.edgeSyncClient = null;       // set externally to call Edge Sync

    this._seed();
  }

  _seed() {
    // Seed demo users
    this.createUser({
      username: "anjali@meshsync.lk",
      password: "demo1234",
      full_name: "Anjali Perera",
      clearance_level: CLEARANCE.COMMANDER,
    });
    this.createUser({
      username: "suresh@meshsync.lk",
      password: "demo1234",
      full_name: "Suresh Silva",
      clearance_level: CLEARANCE.DISPATCHER,
    });
    this.createUser({
      username: "tharindu@meshsync.lk",
      password: "demo1234",
      full_name: "Tharindu Fernando",
      clearance_level: CLEARANCE.DISPATCHER,
    });

    // Seed zones
    this.createZone({ area_name: "Colombo North" });
    this.createZone({ area_name: "Colombo South" });
    this.createZone({ area_name: "Kandy" });
    this.createZone({ area_name: "Galle" });
    this.createZone({ area_name: "Jaffna" });

    // Seed satellite uplinks
    this.createSatelliteUplink({ uplink_name: "Iridium-Base", uplink_type: "IRIDIUM", is_connected: true, bandwidth_kbps: 2 });
    this.createSatelliteUplink({ uplink_name: "Garmin-Relay", uplink_type: "GARMIN", is_connected: false, bandwidth_kbps: 0 });
    this.createSatelliteUplink({ uplink_name: "Starlink-Mobile", uplink_type: "STARLINK", is_connected: true, bandwidth_kbps: 50000 });
  }

  // --- Auth ---

  createUser({ username, password, full_name, clearance_level }) {
    const id = randomUUID();
    const user = {
      id,
      username,
      password_hash: hashPassword(password),
      full_name: full_name || username,
      clearance_level: clearance_level || CLEARANCE.DISPATCHER,
      assigned_cluster_id: null,
      is_active: true,
      created_at: new Date().toISOString(),
    };
    this.users.set(id, user);
    return user;
  }

  authenticate(username, password) {
    for (const user of this.users.values()) {
      if (user.username === username && user.is_active && verifyPassword(password, user.password_hash)) {
        const token = `token-${randomUUID()}`;
        this.sessions.set(token, { userId: user.id, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        const { password_hash, ...safeUser } = user;
        return { token, user: safeUser };
      }
    }
    return null;
  }

  getUserByToken(token) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const user = this.users.get(session.userId);
    if (!user || !user.is_active) return null;
    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  getUsers() {
    return Array.from(this.users.values()).map(({ password_hash, ...u }) => u);
  }

  updateUser(id, updates) {
    const user = this.users.get(id);
    if (!user) return null;
    this.users.set(id, { ...user, ...updates });
    const { password_hash, ...safeUser } = this.users.get(id);
    return safeUser;
  }

  // --- Devices ---

  registerDevice({ node_id, authority_user_id }) {
    const id = randomUUID();
    const device = {
      id,
      node_id,
      authority_user_id,
      is_active: true,
      registered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    };
    this.devices.set(id, device);
    return device;
  }

  getDevices() {
    return Array.from(this.devices.values());
  }

  getActiveDeviceForUser(authorityUserId) {
    // §10.6: resolve the officer's currently-active device
    // (is_active = true, most recent last_seen_at)
    const userDevices = Array.from(this.devices.values())
      .filter((d) => d.authority_user_id === authorityUserId && d.is_active)
      .sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at));
    return userDevices[0] || null;
  }

  revokeDevice(id) {
    const device = this.devices.get(id);
    if (!device) return null;
    device.is_active = false;
    return device;
  }

  // --- Zones ---

  createZone({ area_name }) {
    const id = randomUUID();
    const zone = { id, area_name, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.zones.set(id, zone);
    return zone;
  }

  getZones() {
    return Array.from(this.zones.values());
  }

  updateZone(id, updates) {
    const zone = this.zones.get(id);
    if (!zone) return null;
    this.zones.set(id, { ...zone, ...updates, updated_at: new Date().toISOString() });
    return this.zones.get(id);
  }

  deleteZone(id) {
    return this.zones.delete(id);
  }

  // --- Clusters ---

  createCluster(data) {
    const id = randomUUID();
    const cluster = {
      id,
      centroid_lat: data.centroid_lat || null,
      centroid_lng: data.centroid_lng || null,
      radius_meters: data.radius_meters || 0,
      severity_score: data.severity_score || 0,
      incident_count: data.incident_count || 0,
      status: "ACTIVE",
      resolved_by_admin_id: null,
      resolved_at: null,
      last_recalculated_at: new Date().toISOString(),
    };
    this.clusters.set(id, cluster);
    return cluster;
  }

  getClusters() {
    return Array.from(this.clusters.values());
  }

  resolveCluster(id, adminId) {
    const cluster = this.clusters.get(id);
    if (!cluster) return null;
    cluster.status = "RESOLVED";
    cluster.resolved_by_admin_id = adminId;
    cluster.resolved_at = new Date().toISOString();
    return cluster;
  }

  /**
   * Recalculate clusters from incidents using spatial centroid clustering.
   * Groups geographically adjacent incidents (§10.5.2).
   */
  recalculateClusters(incidents, thresholdMeters = 1000) {
    // Clear existing active clusters
    const activeClusters = Array.from(this.clusters.values()).filter((c) => c.status === "ACTIVE");
    for (const c of activeClusters) {
      this.clusters.delete(c.id);
    }

    // Only cluster OPEN/EN_ROUTE incidents
    const active = incidents.filter((i) => i.status_code === 1 || i.status_code === 2 || i.status_code === 3);
    if (active.length === 0) return [];

    // Simple distance-based clustering
    const visited = new Set();
    const newClusters = [];

    for (const inc of active) {
      if (visited.has(inc.id)) continue;
      const members = [inc];
      visited.add(inc.id);

      for (const other of active) {
        if (visited.has(other.id)) continue;
        const dist = haversine(inc.latitude, inc.longitude, other.latitude, other.longitude);
        if (dist <= thresholdMeters) {
          members.push(other);
          visited.add(other.id);
        }
      }

      if (members.length >= 2) {
        // Compute spherical centroid
        let latSum = 0, lngSum = 0;
        for (const m of members) {
          latSum += m.latitude;
          lngSum += m.longitude;
        }
        const centroidLat = latSum / members.length;
        const centroidLng = lngSum / members.length;

        // Compute radius (Haversine to furthest member)
        let maxDist = 0;
        for (const m of members) {
          const d = haversine(centroidLat, centroidLng, m.latitude, m.longitude);
          if (d > maxDist) maxDist = d;
        }

        // Aggregate severity (max severity of members)
        const severityScore = Math.max(...members.map((m) => m.severity_level || 1));

        const cluster = this.createCluster({
          centroid_lat: centroidLat,
          centroid_lng: centroidLng,
          radius_meters: maxDist,
          severity_score: severityScore,
          incident_count: members.length,
        });
        newClusters.push(cluster);
      }
    }

    return newClusters;
  }

  // --- Squads (§10.6) ---

  createSquad({ squad_name, leader_authority_user_id, zone_id }) {
    const id = randomUUID();
    const squad = {
      id,
      squad_name,
      leader_authority_user_id,
      zone_id: zone_id || null,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.squads.set(id, squad);
    return squad;
  }

  getSquads() {
    return Array.from(this.squads.values());
  }

  getSquadById(id) {
    return this.squads.get(id) || null;
  }

  updateSquad(id, updates) {
    const squad = this.squads.get(id);
    if (!squad) return null;
    this.squads.set(id, { ...squad, ...updates, updated_at: new Date().toISOString() });
    return this.squads.get(id);
  }

  deleteSquad(id) {
    // Also delete members
    for (const [memberId, member] of this.squadMembers) {
      if (member.squad_id === id) {
        this.squadMembers.delete(memberId);
      }
    }
    return this.squads.delete(id);
  }

  addSquadMember({ squad_id, authority_user_id, role_in_squad }) {
    // Check for existing membership (UNIQUE constraint)
    for (const member of this.squadMembers.values()) {
      if (member.squad_id === squad_id && member.authority_user_id === authority_user_id) {
        return null; // already a member
      }
    }
    const id = randomUUID();
    const member = {
      id,
      squad_id,
      authority_user_id,
      role_in_squad: role_in_squad || "RESCUER",
      joined_at: new Date().toISOString(),
      is_active: true,
    };
    this.squadMembers.set(id, member);
    return member;
  }

  getSquadMembers(squadId) {
    return Array.from(this.squadMembers.values()).filter((m) => m.squad_id === squadId && m.is_active);
  }

  removeSquadMember(memberId) {
    const member = this.squadMembers.get(memberId);
    if (!member) return null;
    member.is_active = false;
    return member;
  }

  // --- Satellite Uplinks (§10.7) ---

  createSatelliteUplink(data) {
    const id = randomUUID();
    const uplink = {
      id,
      uplink_name: data.uplink_name,
      uplink_type: data.uplink_type,
      is_connected: data.is_connected || false,
      bandwidth_kbps: data.bandwidth_kbps || 0,
      queue_depth_critical: data.queue_depth_critical || 0,
      queue_depth_high: data.queue_depth_high || 0,
      queue_depth_normal: data.queue_depth_normal || 0,
      last_sync_at: data.last_sync_at || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.satelliteUplinks.set(id, uplink);
    return uplink;
  }

  getSatelliteUplinks() {
    return Array.from(this.satelliteUplinks.values());
  }

  updateSatelliteUplink(id, updates) {
    const uplink = this.satelliteUplinks.get(id);
    if (!uplink) return null;
    this.satelliteUplinks.set(id, { ...uplink, ...updates, updated_at: new Date().toISOString() });
    return this.satelliteUplinks.get(id);
  }

  // --- Dispatch (§10.6) ---

  /**
   * Dispatch a responder to a zone by emitting an ASSIGN event via Edge Sync.
   * §10.6: resolve the officer's currently-active REGISTERED_DEVICE
   * and use its node_id as target_node_id.
   */
  async dispatchResponder({ authority_user_id, zone_id, incident_id, admin_id }) {
    const device = this.getActiveDeviceForUser(authority_user_id);
    if (!device) {
      return { error: "No active device for this user" };
    }

    if (!this.edgeSyncClient) {
      return { error: "Edge Sync client not configured" };
    }

    const event = await this.edgeSyncClient.emitAssign({
      target_node_id: device.node_id,
      target_zone_id: zone_id,
      incident_id,
      assigned_by_admin_id: admin_id,
    });

    return { event, device };
  }

  /**
   * Dispatch an entire squad to a zone — emits N ASSIGN events
   * (one per active squad member).
   */
  async dispatchSquad({ squad_id, zone_id, admin_id }) {
    const squad = this.getSquadById(squad_id);
    if (!squad) return { error: "Squad not found" };

    const members = this.getSquadMembers(squad_id);
    const results = [];

    for (const member of members) {
      const result = await this.dispatchResponder({
        authority_user_id: member.authority_user_id,
        zone_id,
        admin_id,
      });
      results.push({ member_id: member.id, ...result });
    }

    // Update squad's zone assignment
    this.updateSquad(squad_id, { zone_id });

    return { results, squad: this.getSquadById(squad_id) };
  }
}

// Haversine distance in meters
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
