// Command Center Service — database
// Architecture Plan §10.5.2
//
// Owns writes to: CLUSTER, RESPONSE_ZONE, AUTHORITY_USER, REGISTERED_DEVICE,
// RESPONDER_SQUAD, SQUAD_MEMBER, SATELLITE_UPLINK
//
// Reads from: INCIDENT, MESH_EVENT, MESH_ASSIGNMENT (projections owned by Edge Sync)

import { randomUUID } from "node:crypto";
import { CLEARANCE } from "@meshsync/shared/enums";
import { hashPassword, verifyPassword, signSessionToken, verifySessionToken } from "@meshsync/shared/auth";
import { clusterIncidents, haversineDistance } from "./spatial.js";

// ============================================================================
// In-memory Command Center DB (for testing & development)
// ============================================================================

export class InMemoryDb {
  constructor() {
    this.users = new Map();           // id → user
    this.devices = new Map();         // id → device
    this.clusters = new Map();        // id → cluster
    this.zones = new Map();           // id → zone
    this.squads = new Map();          // id → squad
    this.squadMembers = new Map();    // id → member
    this.satelliteUplinks = new Map(); // id → uplink
    this.edgeSyncClient = null;       // set externally to call Edge Sync

    this._seed();
  }

  _seed() {
    // Seed demo users with scrypt hashes
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

  createUser({ username, password, full_name, clearance_level, is_active = true }) {
    const id = randomUUID();
    const user = {
      id,
      username,
      password_hash: hashPassword(password),
      full_name: full_name || username,
      clearance_level: clearance_level || CLEARANCE.DISPATCHER,
      assigned_cluster_id: null,
      is_active: Boolean(is_active),
      created_at: new Date().toISOString(),
    };
    this.users.set(id, user);
    return user;
  }

  authenticate(username, password) {
    for (const user of this.users.values()) {
      if (user.username === username && verifyPassword(password, user.password_hash)) {
        if (!user.is_active) {
          return null;
        }
        const token = signSessionToken({
          userId: user.id,
          username: user.username,
          clearance: user.clearance_level,
        });
        const { password_hash, ...safeUser } = user;
        return { token, user: safeUser };
      }
    }
    return null;
  }

  getUserByToken(token) {
    const payload = verifySessionToken(token);
    if (!payload || !payload.userId) return null;

    const user = this.users.get(payload.userId);
    if (!user || !user.is_active) return null;
    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  getUsers() {
    return Array.from(this.users.values()).map(({ password_hash, ...u }) => u);
  }

  getUserById(id) {
    const user = this.users.get(id);
    if (!user) return null;
    const { password_hash, ...safeUser } = user;
    return safeUser;
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

  recalculateClusters(incidents, thresholdMeters = 1000) {
    // Clear active clusters
    const activeClusters = Array.from(this.clusters.values()).filter((c) => c.status === "ACTIVE");
    for (const c of activeClusters) {
      this.clusters.delete(c.id);
    }

    const clusters = clusterIncidents(incidents, thresholdMeters);
    const created = [];
    for (const data of clusters) {
      created.push(this.createCluster(data));
    }
    return created;
  }

  // --- Squads ---

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
    for (const [memberId, member] of this.squadMembers) {
      if (member.squad_id === id) {
        this.squadMembers.delete(memberId);
      }
    }
    return this.squads.delete(id);
  }

  addSquadMember({ squad_id, authority_user_id, role_in_squad }) {
    for (const member of this.squadMembers.values()) {
      if (member.squad_id === squad_id && member.authority_user_id === authority_user_id) {
        return null; // unique constraint
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

  // --- Satellite Uplinks ---

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

  // --- Dispatch ---

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

    this.updateSquad(squad_id, { zone_id });
    return { results, squad: this.getSquadById(squad_id) };
  }
}

// Alias for backward compatibility with existing tests
export const CommandCenterDb = InMemoryDb;

// ============================================================================
// PostgreSQL Database for Command Center (Production)
// ============================================================================

export class PostgresDb {
  constructor(pool) {
    this.pool = pool;
    this.edgeSyncClient = null;
  }

  async createUser({ username, password, full_name, clearance_level, is_active = false }) {
    const pHash = hashPassword(password);
    const result = await this.pool.query(
      `INSERT INTO authority_user (username, password_hash, full_name, clearance_level, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, full_name, clearance_level, assigned_cluster_id, is_active, created_at`,
      [username, pHash, full_name || username, clearance_level || CLEARANCE.DISPATCHER, is_active]
    );
    return result.rows[0];
  }

  async authenticate(username, password) {
    const result = await this.pool.query(
      `SELECT * FROM authority_user WHERE username = $1`,
      [username]
    );
    const user = result.rows[0];
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
      return null;
    }
    const token = signSessionToken({
      userId: user.id,
      username: user.username,
      clearance: user.clearance_level,
    });
    const { password_hash, ...safeUser } = user;
    return { token, user: safeUser };
  }

  async getUserByToken(token) {
    const payload = verifySessionToken(token);
    if (!payload || !payload.userId) return null;

    const result = await this.pool.query(
      `SELECT id, username, full_name, clearance_level, assigned_cluster_id, is_active, created_at
       FROM authority_user WHERE id = $1 AND is_active = true`,
      [payload.userId]
    );
    return result.rows[0] || null;
  }

  async getUsers() {
    const result = await this.pool.query(
      `SELECT id, username, full_name, clearance_level, assigned_cluster_id, is_active, created_at
       FROM authority_user ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async getUserById(id) {
    const result = await this.pool.query(
      `SELECT id, username, full_name, clearance_level, assigned_cluster_id, is_active, created_at
       FROM authority_user WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  async updateUser(id, updates) {
    const fields = [];
    const params = [id];
    let idx = 2;

    if (updates.is_active != null) {
      fields.push(`is_active = $${idx++}`);
      params.push(updates.is_active);
    }
    if (updates.clearance_level != null) {
      fields.push(`clearance_level = $${idx++}`);
      params.push(updates.clearance_level);
    }
    if (updates.full_name != null) {
      fields.push(`full_name = $${idx++}`);
      params.push(updates.full_name);
    }
    if (updates.assigned_cluster_id != null) {
      fields.push(`assigned_cluster_id = $${idx++}`);
      params.push(updates.assigned_cluster_id);
    }

    if (fields.length === 0) return this.getUserById(id);

    const result = await this.pool.query(
      `UPDATE authority_user SET ${fields.join(", ")} WHERE id = $1
       RETURNING id, username, full_name, clearance_level, assigned_cluster_id, is_active, created_at`,
      params
    );
    return result.rows[0] || null;
  }

  async registerDevice({ node_id, authority_user_id }) {
    const result = await this.pool.query(
      `INSERT INTO registered_device (node_id, authority_user_id, is_active, last_seen_at)
       VALUES ($1, $2, true, now())
       ON CONFLICT (node_id) DO UPDATE SET
         authority_user_id = EXCLUDED.authority_user_id,
         is_active = true,
         last_seen_at = now()
       RETURNING *`,
      [node_id, authority_user_id]
    );
    return result.rows[0];
  }

  async getDevices() {
    const result = await this.pool.query("SELECT * FROM registered_device ORDER BY registered_at DESC");
    return result.rows;
  }

  async getActiveDeviceForUser(authorityUserId) {
    const result = await this.pool.query(
      `SELECT * FROM registered_device
       WHERE authority_user_id = $1 AND is_active = true
       ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
      [authorityUserId]
    );
    return result.rows[0] || null;
  }

  async revokeDevice(id) {
    const result = await this.pool.query(
      `UPDATE registered_device SET is_active = false WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  }

  async createZone({ area_name }) {
    const result = await this.pool.query(
      `INSERT INTO response_zone (area_name) VALUES ($1) RETURNING *`,
      [area_name]
    );
    return result.rows[0];
  }

  async getZones() {
    const result = await this.pool.query("SELECT * FROM response_zone ORDER BY area_name ASC");
    return result.rows;
  }

  async updateZone(id, updates) {
    const result = await this.pool.query(
      `UPDATE response_zone SET area_name = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [updates.area_name, id]
    );
    return result.rows[0] || null;
  }

  async deleteZone(id) {
    const result = await this.pool.query("DELETE FROM response_zone WHERE id = $1 RETURNING id", [id]);
    return result.rowCount > 0;
  }

  async createCluster(data) {
    const result = await this.pool.query(
      `INSERT INTO cluster (centroid_lat, centroid_lng, radius_meters, severity_score, incident_count, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE') RETURNING *`,
      [data.centroid_lat, data.centroid_lng, data.radius_meters, data.severity_score, data.incident_count]
    );
    return result.rows[0];
  }

  async getClusters() {
    const result = await this.pool.query("SELECT * FROM cluster ORDER BY last_recalculated_at DESC");
    return result.rows;
  }

  async resolveCluster(id, adminId) {
    const result = await this.pool.query(
      `UPDATE cluster SET status = 'RESOLVED', resolved_by_admin_id = $1, resolved_at = now() WHERE id = $2 RETURNING *`,
      [adminId, id]
    );
    return result.rows[0] || null;
  }

  async recalculateClusters(incidents, thresholdMeters = 1000) {
    await this.pool.query("DELETE FROM cluster WHERE status = 'ACTIVE'");
    const clusters = clusterIncidents(incidents, thresholdMeters);
    const created = [];
    for (const c of clusters) {
      created.push(await this.createCluster(c));
    }
    return created;
  }

  async createSquad({ squad_name, leader_authority_user_id, zone_id }) {
    const result = await this.pool.query(
      `INSERT INTO responder_squad (squad_name, leader_authority_user_id, zone_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [squad_name, leader_authority_user_id, zone_id || null]
    );
    return result.rows[0];
  }

  async getSquads() {
    const result = await this.pool.query("SELECT * FROM responder_squad WHERE is_active = true");
    return result.rows;
  }

  async getSquadById(id) {
    const result = await this.pool.query("SELECT * FROM responder_squad WHERE id = $1", [id]);
    return result.rows[0] || null;
  }

  async updateSquad(id, updates) {
    const fields = [];
    const params = [id];
    let idx = 2;

    if (updates.squad_name != null) {
      fields.push(`squad_name = $${idx++}`);
      params.push(updates.squad_name);
    }
    if (updates.zone_id !== undefined) {
      fields.push(`zone_id = $${idx++}`);
      params.push(updates.zone_id);
    }
    if (updates.is_active != null) {
      fields.push(`is_active = $${idx++}`);
      params.push(updates.is_active);
    }

    if (fields.length === 0) return this.getSquadById(id);

    fields.push("updated_at = now()");
    const result = await this.pool.query(
      `UPDATE responder_squad SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  async deleteSquad(id) {
    await this.pool.query("DELETE FROM squad_member WHERE squad_id = $1", [id]);
    const result = await this.pool.query("DELETE FROM responder_squad WHERE id = $1 RETURNING id", [id]);
    return result.rowCount > 0;
  }

  async addSquadMember({ squad_id, authority_user_id, role_in_squad }) {
    try {
      const result = await this.pool.query(
        `INSERT INTO squad_member (squad_id, authority_user_id, role_in_squad)
         VALUES ($1, $2, $3) RETURNING *`,
        [squad_id, authority_user_id, role_in_squad || "RESCUER"]
      );
      return result.rows[0];
    } catch {
      return null; // unique violation or FK violation
    }
  }

  async getSquadMembers(squadId) {
    const result = await this.pool.query(
      `SELECT * FROM squad_member WHERE squad_id = $1 AND is_active = true`,
      [squadId]
    );
    return result.rows;
  }

  async removeSquadMember(memberId) {
    const result = await this.pool.query(
      `UPDATE squad_member SET is_active = false WHERE id = $1 RETURNING *`,
      [memberId]
    );
    return result.rows[0] || null;
  }

  async createSatelliteUplink(data) {
    const result = await this.pool.query(
      `INSERT INTO satellite_uplink (uplink_name, uplink_type, is_connected, bandwidth_kbps,
        queue_depth_critical, queue_depth_high, queue_depth_normal)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        data.uplink_name,
        data.uplink_type,
        data.is_connected || false,
        data.bandwidth_kbps || 0,
        data.queue_depth_critical || 0,
        data.queue_depth_high || 0,
        data.queue_depth_normal || 0,
      ]
    );
    return result.rows[0];
  }

  async getSatelliteUplinks() {
    const result = await this.pool.query("SELECT * FROM satellite_uplink ORDER BY uplink_name ASC");
    return result.rows;
  }

  async updateSatelliteUplink(id, updates) {
    const fields = [];
    const params = [id];
    let idx = 2;

    if (updates.is_connected != null) {
      fields.push(`is_connected = $${idx++}`);
      params.push(updates.is_connected);
    }
    if (updates.bandwidth_kbps != null) {
      fields.push(`bandwidth_kbps = $${idx++}`);
      params.push(updates.bandwidth_kbps);
    }
    if (updates.queue_depth_critical != null) {
      fields.push(`queue_depth_critical = $${idx++}`);
      params.push(updates.queue_depth_critical);
    }
    if (updates.last_sync_at) {
      fields.push(`last_sync_at = $${idx++}`);
      params.push(new Date(updates.last_sync_at));
    }

    if (fields.length === 0) return null;

    fields.push("updated_at = now()");
    const result = await this.pool.query(
      `UPDATE satellite_uplink SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  async dispatchResponder({ authority_user_id, zone_id, incident_id, admin_id }) {
    const device = await this.getActiveDeviceForUser(authority_user_id);
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

  async dispatchSquad({ squad_id, zone_id, admin_id }) {
    const squad = await this.getSquadById(squad_id);
    if (!squad) return { error: "Squad not found" };

    const members = await this.getSquadMembers(squad_id);
    const results = [];

    for (const member of members) {
      const result = await this.dispatchResponder({
        authority_user_id: member.authority_user_id,
        zone_id,
        admin_id,
      });
      results.push({ member_id: member.id, ...result });
    }

    await this.updateSquad(squad_id, { zone_id });
    const updatedSquad = await this.getSquadById(squad_id);
    return { results, squad: updatedSquad };
  }
}

export function createDb(usePostgres = false, pool = null) {
  if (usePostgres && pool) {
    return new PostgresDb(pool);
  }
  return new InMemoryDb();
}
