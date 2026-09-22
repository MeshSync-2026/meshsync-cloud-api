// Database abstraction for Edge Sync Service.
// Supports PostgreSQL (production) and in-memory (testing/demo).

// In production: uses node:pg (or pg package) to connect to PostgreSQL.
// In testing/demo: uses an in-memory store that implements the same interface.

// This abstraction lets us run the full ingest → fold → projection pipeline
// without requiring a running PostgreSQL instance.

import { foldPipeline } from "@meshsync/shared/fold";
import { createCloudClock } from "@meshsync/shared/hlc";
import { validateBatch } from "@meshsync/shared/validation";
import {
    EVENT_TYPE,
    CLOUD_NODE_ID,
} from "@meshsync/shared/enums";


// In-memory database (for testing and demo)


export class InMemoryDb {
    constructor() {
        this.meshEvents = new Map();       // id → event
        this.incidents = new Map();        // id → projection
        this.responders = new Map();       // id → entry
        this.history = [];                 // array of history entries
        this.assignments = new Map();      // id → assignment
        this.batches = [];                 // ingestion batch log
        this.batchItems = [];              // per row outcomes
        this.cloudClock = createCloudClock();
    }

    /**
     * Insert events with idempotent ON CONFLICT DO NOTHING semantics.
     * Returns { newCount, duplicateCount, rejectedCount, items }
     */
    async ingestEvents(events, uploadingNodeId = "data-mule-001") {
        const { valid, invalid } = validateBatch(events);

        let newCount = 0;
        let duplicateCount = 0;
        const items = [];

        for (const evt of valid) {
            if (this.meshEvents.has(evt.id)) {
                duplicateCount++;
                items.push({
                    table_name: "MESH_EVENT",
                    row_id: evt.id,
                    outcome: "duplicate_ignored",
                    error_detail: null,
                });
            } else {
                this.meshEvents.set(evt.id, { ...evt, first_ingested_at: new Date().toISOString() });
                newCount++;
                items.push({
                    table_name: "MESH_EVENT",
                    row_id: evt.id,
                    outcome: "inserted",
                    error_detail: null,
                });
            }
        }

        for (const { event, errors } of invalid) {
            items.push({
                table_name: "MESH_EVENT",
                row_id: event?.id || null,
                outcome: "rejected",
                error_detail: errors.join("; "),
            });
        }

        const batch = {
            id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            uploading_node_id: uploadingNodeId,
            received_at: new Date().toISOString(),
            new_count: newCount,
            updated_count: 0,
            duplicate_count: duplicateCount,
            rejected_count: invalid.length,
        };
        this.batches.push(batch);
        this.batchItems.push(...items.map((it) => ({ ...it, batch_id: batch.id })));

        // Rebuild projections after ingest (§11.4: projections rebuilt from log)
        await this.rebuildProjections();

        return { batch, newCount, duplicateCount, rejectedCount: invalid.length, items };
    }

    /**
     * Rebuild all projections from the MESH_EVENT log via the fold pipeline.
     * This is the core CQRS read-model rebuild (§11.6).
     */
    async rebuildProjections() {
        const events = Array.from(this.meshEvents.values());
        const currentPhysical = this.cloudClock.getPhysical();
        const result = foldPipeline(events, currentPhysical);

        // Replace projections
        this.incidents.clear();
        for (const inc of result.incidents) {
            this.incidents.set(inc.id, inc);
        }

        this.responders.clear();
        for (const r of result.responders) {
            const rId = `${r.incident_id}|${r.responder_node_id}`;
            this.responders.set(rId, r);
        }

        this.history = result.history;
        this.assignments.clear();
        for (const a of result.assignments) {
            const aId = `${a.responder_node_id}|${a.zone_id}`;
            this.assignments.set(aId, a);
        }
    }

    /**
     * Emit a cloud origin ASSIGN event.
     * The Command Center Service calls this to dispatch a responder.
     */
    async emitAssignEvent({ targetNodeId, targetZoneId, incidentId = null, assignedByAdminId = null }) {
        const hlc = this.cloudClock.tick();
        const eventId = `cloud-assign-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        const incId = incidentId || `assign-${now}`;
        const event = {
            id: eventId,
            parent_id: null,
            incident_id: incId,
            origin_node_id: CLOUD_NODE_ID,
            seq: 0,
            event_type_code: EVENT_TYPE.ASSIGN,
            actor_role_code: 3, // Registered Responder (cloud origin)
            latitude: null,
            longitude: null,
            landmark_name: null,
            report_type_code: null,
            category_code: null,
            severity_level: null,
            status_safety: null,
            people_count: null,
            status_water: null,
            status_injury: null,
            target_node_id: targetNodeId,
            target_zone_id: targetZoneId,
            hlc_timestamp: hlc,
            assigned_by_admin_id: assignedByAdminId,
            created_at: now,
        };
        this.meshEvents.set(event.id, { ...event, first_ingested_at: new Date().toISOString() });
        await this.rebuildProjections();
        if (assignedByAdminId) {
            for (const assign of this.assignments.values()) {
                if (assign.source_mesh_event_id === eventId || (assign.target_node_id === targetNodeId && assign.incident_id === incId)) {
                    assign.assigned_by_admin_id = assignedByAdminId;
                }
            }
        }
        return event;
    }

    // Read methods

    async getIncidents(filters = {}) {
        let result = Array.from(this.incidents.values());
        if (filters.status_code) result = result.filter((i) => i.status_code === filters.status_code);
        if (filters.confidence_code) result = result.filter((i) => i.confidence_code === filters.confidence_code);
        if (filters.zone_id) result = result.filter((i) => i.zone_id === filters.zone_id);
        if (filters.cluster_id) result = result.filter((i) => i.cluster_id === filters.cluster_id);
        return result.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    }

    async getIncidentById(id) {
        return this.incidents.get(id) || null;
    }

    async getEventsByIncident(incidentId) {
        return Array.from(this.meshEvents.values())
            .filter((e) => e.incident_id === incidentId)
            .sort((a, b) => (a.hlc_timestamp < b.hlc_timestamp ? -1 : 1));
    }

    async getRespondersByIncident(incidentId) {
        return Array.from(this.responders.values()).filter((r) => r.incident_id === incidentId);
    }

    async getHistoryByIncident(incidentId) {
        return this.history.filter((h) => h.incident_id === incidentId);
    }

    async getAssignments() {
        return Array.from(this.assignments.values());
    }

    async getMeshEvents(filters = {}) {
        let result = Array.from(this.meshEvents.values());
        if (filters.event_type_code) result = result.filter((e) => e.event_type_code === filters.event_type_code);
        if (filters.incident_id) result = result.filter((e) => e.incident_id === filters.incident_id);
        if (filters.since_hlc) result = result.filter((e) => e.hlc_timestamp > filters.since_hlc);
        return result.sort((a, b) => (a.hlc_timestamp < b.hlc_timestamp ? -1 : 1));
    }

    async getBatches() {
        return this.batches.slice().reverse(); // newest first
    }

    async getBatchItems(batchId) {
        return this.batchItems.filter((it) => it.batch_id === batchId);
    }

    /**
     * GET /sync — pull endpoint for Data Mules.
     * Returns events above the given HLC watermark.
     */
    async getSyncEvents(sinceHlc) {
        let events = Array.from(this.meshEvents.values());
        if (sinceHlc) {
            events = events.filter((e) => e.hlc_timestamp > sinceHlc);
        }
        events.sort((a, b) => (a.hlc_timestamp < b.hlc_timestamp ? -1 : 1));
        return events;
    }
}


// PostgreSQL database (production)


export class PostgresDb {
    constructor(pool) {
        this.pool = pool;
        this.cloudClock = createCloudClock();
    }

    async ingestEvents(events, uploadingNodeId = "data-mule-001") {
        const { valid, invalid } = validateBatch(events);
        const client = await this.pool.connect();

        try {
            await client.query("BEGIN");

            // Create batch record
            const batchResult = await client.query(
                `INSERT INTO ingestion_batch (uploading_node_id, new_count, duplicate_count, rejected_count)
         VALUES ($1, 0, 0, 0) RETURNING id`,
                [uploadingNodeId]
            );
            const batchId = batchResult.rows[0].id;

            let newCount = 0;
            let duplicateCount = 0;
            let rejectedDbCount = 0;
            const items = [];

            for (const evt of valid) {
                try {
                    const result = await client.query(
                        `INSERT INTO mesh_event (
              id, parent_id, incident_id, origin_node_id, seq, event_type_code,
              actor_role_code, latitude, longitude, landmark_name, report_type_code,
              category_code, severity_level, status_safety, people_count,
              status_water, status_injury, target_node_id, target_zone_id,
              hlc_timestamp, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
            ON CONFLICT (id) DO NOTHING RETURNING id`,
                        [
                            evt.id, evt.parent_id, evt.incident_id, evt.origin_node_id, evt.seq,
                            evt.event_type_code, evt.actor_role_code, evt.latitude, evt.longitude,
                            evt.landmark_name, evt.report_type_code, evt.category_code,
                            evt.severity_level, evt.status_safety, evt.people_count,
                            evt.status_water, evt.status_injury, evt.target_node_id, evt.target_zone_id,
                            evt.hlc_timestamp, new Date(evt.created_at),
                        ]
                    );

                    if (result.rowCount > 0) {
                        newCount++;
                        items.push({ batch_id: batchId, table_name: "MESH_EVENT", row_id: evt.id, outcome: "inserted", error_detail: null });
                    } else {
                        duplicateCount++;
                        items.push({ batch_id: batchId, table_name: "MESH_EVENT", row_id: evt.id, outcome: "duplicate_ignored", error_detail: null });
                    }
                } catch (err) {
                    rejectedDbCount++;
                    items.push({ batch_id: batchId, table_name: "MESH_EVENT", row_id: evt.id, outcome: "rejected", error_detail: err.message });
                }
            }

            for (const { event, errors } of invalid) {
                items.push({ batch_id: batchId, table_name: "MESH_EVENT", row_id: event?.id || null, outcome: "rejected", error_detail: errors.join("; ") });
            }

            const totalRejected = invalid.length + rejectedDbCount;

            // Update batch counts
            await client.query(
                `UPDATE ingestion_batch SET new_count = $1, duplicate_count = $2, rejected_count = $3 WHERE id = $4`,
                [newCount, duplicateCount, totalRejected, batchId]
            );

            // Insert batch items
            for (const item of items) {
                await client.query(
                    `INSERT INTO ingestion_batch_item (batch_id, table_name, row_id, outcome, error_detail) VALUES ($1,$2,$3,$4,$5)`,
                    [item.batch_id, item.table_name, item.row_id, item.outcome, item.error_detail]
                );
            }

            await client.query("COMMIT");

            // Extract affected incident IDs for incremental projection rebuild
            const affectedIncidentIds = new Set(valid.map((e) => e.incident_id).filter(Boolean));

            // Rebuild projections for affected incidents
            await this.rebuildProjections(affectedIncidentIds);

            return {
                batch: { id: batchId, new_count: newCount, duplicate_count: duplicateCount, rejected_count: totalRejected },
                newCount, duplicateCount, rejectedCount: totalRejected, items,
            };
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    async rebuildProjections(affectedIncidentIds = null) {
        let query = "SELECT * FROM mesh_event";
        const params = [];
        if (affectedIncidentIds && affectedIncidentIds.size > 0) {
            query += " WHERE incident_id = ANY($1::text[])";
            params.push(Array.from(affectedIncidentIds));
        }
        query += " ORDER BY hlc_timestamp";

        const result = await this.pool.query(query, params);
        const events = result.rows.map((r) => ({ ...r, created_at: new Date(r.created_at).getTime() }));
        const folded = foldPipeline(events, this.cloudClock.getPhysical());

        // Handle deleted/tombstoned projections
        if (affectedIncidentIds && affectedIncidentIds.size > 0) {
            const affectedArray = Array.from(affectedIncidentIds);
            const foldedIds = new Set(folded.incidents.map((i) => i.id));
            const deletedIds = affectedArray.filter((id) => !foldedIds.has(id));
            if (deletedIds.length > 0) {
                await this.pool.query(`DELETE FROM incident_responder WHERE incident_id = ANY($1::text[])`, [deletedIds]);
                await this.pool.query(`DELETE FROM incident_history WHERE incident_id = ANY($1::text[])`, [deletedIds]);
                await this.pool.query(`DELETE FROM mesh_assignment WHERE incident_id = ANY($1::text[])`, [deletedIds]);
                await this.pool.query(`DELETE FROM incident WHERE id = ANY($1::text[])`, [deletedIds]);
            }
        }

        // Upsert incidents
        const foldedIncidentIds = new Set(folded.incidents.map((i) => i.id));
        for (const inc of folded.incidents) {
            await this.pool.query(
                `INSERT INTO incident (
          id, creator_node_id, latitude, longitude, landmark_name, report_type_code,
          category_code, severity_level, status_code, confidence_code, status_safety,
          people_count, status_water, status_injury, last_heartbeat_at, last_alive_hlc,
          last_event_hlc, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (id) DO UPDATE SET
          latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
          landmark_name = EXCLUDED.landmark_name, severity_level = EXCLUDED.severity_level,
          status_code = EXCLUDED.status_code, confidence_code = EXCLUDED.confidence_code,
          status_safety = EXCLUDED.status_safety, people_count = EXCLUDED.people_count,
          status_water = EXCLUDED.status_water, status_injury = EXCLUDED.status_injury,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at, last_alive_hlc = EXCLUDED.last_alive_hlc,
          last_event_hlc = EXCLUDED.last_event_hlc, updated_at = EXCLUDED.updated_at`,
                [
                    inc.id, inc.creator_node_id, inc.latitude, inc.longitude, inc.landmark_name,
                    inc.report_type_code, inc.category_code, inc.severity_level, inc.status_code,
                    inc.confidence_code, inc.status_safety, inc.people_count, inc.status_water,
                    inc.status_injury, inc.last_heartbeat_at ? new Date(inc.last_heartbeat_at) : null,
                    inc.last_alive_hlc, inc.last_event_hlc, new Date(inc.created_at), new Date(inc.updated_at),
                ]
            );
        }

        // Upsert responders
        for (const r of folded.responders) {
            const rId = `${r.incident_id}|${r.responder_node_id}`;
            await this.pool.query(
                `INSERT INTO incident_responder (id, incident_id, responder_node_id, actor_role_code, hlc_timestamp, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           actor_role_code = EXCLUDED.actor_role_code,
           hlc_timestamp = EXCLUDED.hlc_timestamp,
           joined_at = EXCLUDED.joined_at`,
                [rId, r.incident_id, r.responder_node_id, r.actor_role_code, r.hlc_timestamp, new Date(r.joined_at)]
            );
        }

        // Insert incident history (safely ensuring parent incident exists for out-of-order events)
        for (const h of folded.history) {
            if (!foldedIncidentIds.has(h.incident_id)) {
                await this.pool.query(
                    `INSERT INTO incident (id, creator_node_id, latitude, longitude, report_type_code, status_code, confidence_code, created_at, updated_at)
                     VALUES ($1, $2, 0, 0, 1, 1, 2, $3, $3)
                     ON CONFLICT (id) DO NOTHING`,
                    [h.incident_id, h.actor_node_id || 'unknown', new Date(h.created_at || Date.now())]
                );
            }
            const hId = `${h.source_mesh_event_id || h.incident_id + '-' + h.hlc_timestamp}`;
            await this.pool.query(
                `INSERT INTO incident_history (id, incident_id, actor_node_id, action_type_code, hlc_timestamp, source_mesh_event_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
                [hId, h.incident_id, h.actor_node_id, h.action_type_code, h.hlc_timestamp, h.source_mesh_event_id, new Date(h.created_at)]
            );
        }

        // Upsert mesh assignments
        for (const a of folded.assignments) {
            const aId = `${a.responder_node_id}|${a.zone_id}`;
            await this.pool.query(
                `INSERT INTO mesh_assignment (id, responder_node_id, zone_id, hlc_timestamp, assigned_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           hlc_timestamp = EXCLUDED.hlc_timestamp,
           assigned_at = EXCLUDED.assigned_at,
           updated_at = now()`,
                [aId, a.responder_node_id, a.zone_id, a.hlc_timestamp, new Date(a.assigned_at)]
            );
        }
    }

    async emitAssignEvent({ targetNodeId, targetZoneId, incidentId = null, assignedByAdminId = null }) {
        const hlc = this.cloudClock.tick();
        const eventId = `cloud-assign-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date();
        const incId = incidentId || `assign-${Date.now()}`;
        await this.pool.query(
            `INSERT INTO mesh_event (id, incident_id, origin_node_id, seq, event_type_code,
        actor_role_code, target_node_id, target_zone_id, hlc_timestamp, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [eventId, incId, CLOUD_NODE_ID, 0, EVENT_TYPE.ASSIGN,
                3, targetNodeId, targetZoneId, hlc, now]
        );
        const affectedIncidents = incidentId ? new Set([incidentId]) : null;
        await this.rebuildProjections(affectedIncidents);

        if (assignedByAdminId) {
            await this.pool.query(
                `UPDATE mesh_assignment SET assigned_by_admin_id = $1 WHERE source_mesh_event_id = $2 OR (responder_node_id = $3)`,
                [assignedByAdminId, eventId, targetNodeId]
            );
        }

        return {
            id: eventId,
            incident_id: incId,
            origin_node_id: CLOUD_NODE_ID,
            seq: 0,
            event_type_code: EVENT_TYPE.ASSIGN,
            actor_role_code: 3,
            target_node_id: targetNodeId,
            target_zone_id: targetZoneId,
            hlc_timestamp: hlc,
            assigned_by_admin_id: assignedByAdminId,
            created_at: now.getTime(),
        };
    }

    async getIncidents(filters = {}) {
        let query = "SELECT * FROM incident WHERE 1=1";
        const params = [];
        let paramIdx = 1;
        if (filters.status_code) { query += ` AND status_code = $${paramIdx++}`; params.push(filters.status_code); }
        if (filters.confidence_code) { query += ` AND confidence_code = $${paramIdx++}`; params.push(filters.confidence_code); }
        if (filters.zone_id) { query += ` AND zone_id = $${paramIdx++}`; params.push(filters.zone_id); }
        query += " ORDER BY created_at DESC";
        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getIncidentById(id) {
        const result = await this.pool.query("SELECT * FROM incident WHERE id = $1", [id]);
        return result.rows[0] || null;
    }

    async getEventsByIncident(incidentId) {
        const result = await this.pool.query("SELECT * FROM mesh_event WHERE incident_id = $1 ORDER BY hlc_timestamp", [incidentId]);
        return result.rows;
    }

    async getRespondersByIncident(incidentId) {
        const result = await this.pool.query("SELECT * FROM incident_responder WHERE incident_id = $1", [incidentId]);
        return result.rows;
    }

    async getHistoryByIncident(incidentId) {
        const result = await this.pool.query("SELECT * FROM incident_history WHERE incident_id = $1 ORDER BY created_at", [incidentId]);
        return result.rows;
    }

    async getAssignments() {
        const result = await this.pool.query("SELECT * FROM mesh_assignment");
        return result.rows;
    }

    async getMeshEvents(filters = {}) {
        let query = "SELECT * FROM mesh_event WHERE 1=1";
        const params = [];
        let paramIdx = 1;
        if (filters.event_type_code) { query += ` AND event_type_code = $${paramIdx++}`; params.push(filters.event_type_code); }
        if (filters.incident_id) { query += ` AND incident_id = $${paramIdx++}`; params.push(filters.incident_id); }
        if (filters.since_hlc) { query += ` AND hlc_timestamp > $${paramIdx++}`; params.push(filters.since_hlc); }
        query += " ORDER BY hlc_timestamp";
        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getBatches() {
        const result = await this.pool.query("SELECT * FROM ingestion_batch ORDER BY received_at DESC");
        return result.rows;
    }

    async getBatchItems(batchId) {
        const result = await this.pool.query("SELECT * FROM ingestion_batch_item WHERE batch_id = $1", [batchId]);
        return result.rows;
    }

    async getSyncEvents(sinceHlc) {
        let query = "SELECT * FROM mesh_event";
        const params = [];
        if (sinceHlc) {
            query += " WHERE hlc_timestamp > $1";
            params.push(sinceHlc);
        }
        query += " ORDER BY hlc_timestamp";
        const result = await this.pool.query(query, params);
        return result.rows;
    }
}

// Factory: create the right DB based on environment
export function createDb(usePostgres = false, pool = null) {
    if (usePostgres && pool) {
        return new PostgresDb(pool);
    }
    return new InMemoryDb();
}