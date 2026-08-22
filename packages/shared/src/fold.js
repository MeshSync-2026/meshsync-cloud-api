// Rebuilds projections (INCIDENT, INCIDENT_RESPONDER, INCIDENT_HISTORY,MESH_ASSIGNMENT) from the MESH_EVENT log via a deterministic pipeline.

// fold pipeline stages (order matters):
//   1. Tombstone filter  drop events for purged incidents
//   2. Heartbeat compaction  keep only latest SOS_ALIVE per (incident_id, origin_node_id)
//   3. HLC sort  order surviving events by hlc_timestamp (lexical = causal)
//   4. LWW fold  apply events in HLC order to build projections
//   5. Confidence derivation  compare last_alive_hlc to current device HLC

// Determinism:every replica with the same MESH_EVENT set produces the same projection through this pipeline.

import {
  EVENT_TYPE,
  STATUS,
  CONFIDENCE,
  ACTION_TYPE,
  HEARTBEAT_INTERVAL_MS,
  CONFIDENCE_THRESHOLD_MS,
} from "./enums.js";
import { parseHlc, compareHlc } from "./hlc.js";

 // Stage 1: Tombstone filter
 // Drop events for incident_ids where a TOMBSTONE event exists and the event's HLC <= the tombstone's resolution_hlc.
 // @param {Array} events : all MESH_EVENT rows
 // @returns {Array} events with tombstoned events removed
 
export function tombstoneFilter(events) {
  // Build a map of incident_id gives resolution_hlc from TOMBSTONE events
  const tombstones = new Map();
  for (const evt of events) {
    if (evt.event_type_code === EVENT_TYPE.TOMBSTONE) {
      const existing = tombstones.get(evt.incident_id);
      if (!existing || compareHlc(evt.hlc_timestamp, existing) > 0) {
        tombstones.set(evt.incident_id, evt.hlc_timestamp);
      }
    }
  }

  // Also handle SOS_RESOLVED and SOS_CANCELLED as soft tombstones
  // (they change confidence but don't purge ,only TOMBSTONE purges)
  // We only filter by TOMBSTONE events here.

  return events.filter((evt) => {
    const tombstoneHlc = tombstones.get(evt.incident_id);
    if (tombstoneHlc && compareHlc(evt.hlc_timestamp, tombstoneHlc) <= 0) {
      // Drop this event , it's been tombstoned
      // But keep the TOMBSTONE event itself
      return evt.event_type_code === EVENT_TYPE.TOMBSTONE;
    }
    return true;
  });
}


 // Stage 2: Heartbeat compaction
// Keep only the latest SOS_ALIVE per (incident_id, origin_node_id) pair.
 // Older SOS_ALIVE events for the same pair are skipped (not deleted from log).
 
// @param {Array} events - events after tombstone filter
 // @returns {Array} events with redundant heartbeats removed

export function heartbeatCompaction(events) {
  // Find the latest SOS_ALIVE HLC per (incident_id, origin_node_id)
  const latestHeartbeat = new Map(); // key: "incident_id|origin_node_id" gives hlc
  for (const evt of events) {
    if (evt.event_type_code === EVENT_TYPE.SOS_ALIVE) {
      const key = `${evt.incident_id}|${evt.origin_node_id}`;
      const existing = latestHeartbeat.get(key);
      if (!existing || compareHlc(evt.hlc_timestamp, existing) > 0) {
        latestHeartbeat.set(key, evt.hlc_timestamp);
      }
    }
  }

  return events.filter((evt) => {
    if (evt.event_type_code !== EVENT_TYPE.SOS_ALIVE) return true;
    const key = `${evt.incident_id}|${evt.origin_node_id}`;
    const latest = latestHeartbeat.get(key);
    // Keep only if this IS the latest heartbeat for this pair
    return compareHlc(evt.hlc_timestamp, latest) === 0;
  });
}


 // Stage 3: HLC sort
 // Order surviving events by hlc_timestamp (lexical = causal).
 
 // @param {Array} events
 // @returns {Array} sorted events

export function hlcSort(events) {
  return [...events].sort((a, b) => compareHlc(a.hlc_timestamp, b.hlc_timestamp));
}


 // Stage 4: LWW fold
 // Apply events in HLC order to build projections.
 // Last Write Wins at the field level : non destructive (losing writes are still in the log, just not reflected in the projection).
 
 // @param {Array} sortedEvents : events sorted by HLC
 // @returns {{ incidents: Map, responders: Map, history: Array, assignments: Map }}
 
export function lwwFold(sortedEvents) {
  const incidents = new Map(); // incident_id -> projection
  const responders = new Map(); // "incident_id|responder_node_id" -> entry
  const history = []; // array of INCIDENT_HISTORY entries
  const assignments = new Map(); // "responder_node_id|zone_id" -> assignment

  for (const evt of sortedEvents) {
    const incId = evt.incident_id;

    switch (evt.event_type_code) {
      case EVENT_TYPE.SOS_CREATED: {
        // Create or update the incident projection
        const existing = incidents.get(incId) || {};
        incidents.set(incId, {
          ...existing,
          id: incId,
          creator_node_id: evt.origin_node_id,
          latitude: evt.latitude,
          longitude: evt.longitude,
          landmark_name: evt.landmark_name || null,
          report_type_code: evt.report_type_code,
          category_code: evt.category_code || null,
          severity_level: evt.severity_level,
          status_safety: evt.status_safety,
          people_count: evt.people_count,
          status_water: evt.status_water,
          status_injury: evt.status_injury,
          status_code: STATUS.OPEN,
          confidence_code: CONFIDENCE.LIVE,
          last_heartbeat_at: evt.created_at,
          last_alive_hlc: evt.hlc_timestamp,
          last_event_hlc: evt.hlc_timestamp,
          created_at: evt.created_at,
          updated_at: evt.created_at,
        });
        history.push({
          incident_id: incId,
          actor_node_id: evt.origin_node_id,
          action_type_code: ACTION_TYPE.CREATED,
          hlc_timestamp: evt.hlc_timestamp,
          source_mesh_event_id: evt.id,
          created_at: evt.created_at,
        });
        break;
      }

      case EVENT_TYPE.RESPONDER_EN_ROUTE: {
        // Add responder to the incident's responder set
        const rKey = `${incId}|${evt.origin_node_id}`;
        responders.set(rKey, {
          incident_id: incId,
          responder_node_id: evt.origin_node_id,
          actor_role_code: evt.actor_role_code,
          hlc_timestamp: evt.hlc_timestamp,
          joined_at: evt.created_at,
        });
        // Update incident status to EN_ROUTE if it was OPEN or ASSIGNED
        const inc = incidents.get(incId);
        if (inc && (inc.status_code === STATUS.OPEN || inc.status_code === STATUS.ASSIGNED)) {
          inc.status_code = STATUS.EN_ROUTE;
          inc.updated_at = evt.created_at;
          inc.last_event_hlc = evt.hlc_timestamp;
        }
        history.push({
          incident_id: incId,
          actor_node_id: evt.origin_node_id,
          action_type_code: ACTION_TYPE.SELF_ASSIGNED,
          hlc_timestamp: evt.hlc_timestamp,
          source_mesh_event_id: evt.id,
          created_at: evt.created_at,
        });
        break;
      }

      case EVENT_TYPE.STATUS_UPDATE: {
        // Update incident fields via LWW
        const inc = incidents.get(incId);
        if (inc) {
          if (evt.severity_level != null) inc.severity_level = evt.severity_level;
          if (evt.status_safety != null) inc.status_safety = evt.status_safety;
          if (evt.people_count != null) inc.people_count = evt.people_count;
          if (evt.status_water != null) inc.status_water = evt.status_water;
          if (evt.status_injury != null) inc.status_injury = evt.status_injury;
          if (evt.latitude != null) inc.latitude = evt.latitude;
          if (evt.longitude != null) inc.longitude = evt.longitude;
          if (evt.landmark_name != null) inc.landmark_name = evt.landmark_name;
          inc.updated_at = evt.created_at;
          inc.last_event_hlc = evt.hlc_timestamp;
        }
        history.push({
          incident_id: incId,
          actor_node_id: evt.origin_node_id,
          action_type_code: ACTION_TYPE.STATUS_UPDATED,
          hlc_timestamp: evt.hlc_timestamp,
          source_mesh_event_id: evt.id,
          created_at: evt.created_at,
        });
        break;
      }

      case EVENT_TYPE.SOS_ALIVE: {
        // Update heartbeat info : this is the latest alive (compaction ensured this)
        const inc = incidents.get(incId);
        if (inc) {
          inc.last_heartbeat_at = evt.created_at;
          inc.last_alive_hlc = evt.hlc_timestamp;
          if (evt.latitude != null) inc.latitude = evt.latitude;
          if (evt.longitude != null) inc.longitude = evt.longitude;
          inc.updated_at = evt.created_at;
          inc.last_event_hlc = evt.hlc_timestamp;
          // If was RESOLVED/CANCELLED, a heartbeat reopens it (Creator Override)
          if (inc.confidence_code === CONFIDENCE.RESOLVED || inc.confidence_code === CONFIDENCE.CANCELLED) {
            inc.confidence_code = CONFIDENCE.LIVE;
            inc.status_code = STATUS.OPEN;
          }
        }
        // Don't add heartbeats to history (too noisy)
        break;
      }

      case EVENT_TYPE.SOS_RESOLVED: {
        const inc = incidents.get(incId);
        if (inc) {
          inc.status_code = STATUS.RESOLVED;
          inc.confidence_code = CONFIDENCE.RESOLVED;
          inc.updated_at = evt.created_at;
          inc.last_event_hlc = evt.hlc_timestamp;
        }
        history.push({
          incident_id: incId,
          actor_node_id: evt.origin_node_id,
          action_type_code: ACTION_TYPE.RESOLVED,
          hlc_timestamp: evt.hlc_timestamp,
          source_mesh_event_id: evt.id,
          created_at: evt.created_at,
        });
        break;
      }

      case EVENT_TYPE.SOS_CANCELLED: {
        const inc = incidents.get(incId);
        if (inc) {
          inc.status_code = STATUS.RESOLVED; // Cancelled = resolved in status terms
          inc.confidence_code = CONFIDENCE.CANCELLED;
          inc.updated_at = evt.created_at;
          inc.last_event_hlc = evt.hlc_timestamp;
        }
        history.push({
          incident_id: incId,
          actor_node_id: evt.origin_node_id,
          action_type_code: ACTION_TYPE.CANCELLED,
          hlc_timestamp: evt.hlc_timestamp,
          source_mesh_event_id: evt.id,
          created_at: evt.created_at,
        });
        break;
      }

      case EVENT_TYPE.TOMBSTONE: {
        // Tombstone events don't update the projection directly : they were used in Stage 1 to filter. But we keep a record.
        break;
      }

      case EVENT_TYPE.ASSIGN: {
        // Project MESH_ASSIGNMENT from ASSIGN events
        const targetNode = evt.target_node_id;
        const targetZone = evt.target_zone_id;
        if (targetNode && targetZone) {
          const aKey = `${targetNode}|${targetZone}`;
          assignments.set(aKey, {
            responder_node_id: targetNode,
            zone_id: targetZone,
            hlc_timestamp: evt.hlc_timestamp,
            assigned_at: evt.created_at,
          });
        }
        // Update incident status to ASSIGNED if it was OPEN
        const inc = incidents.get(incId);
        if (inc && inc.status_code === STATUS.OPEN) {
          inc.status_code = STATUS.ASSIGNED;
          inc.updated_at = evt.created_at;
          inc.last_event_hlc = evt.hlc_timestamp;
        }
        history.push({
          incident_id: incId,
          actor_node_id: evt.origin_node_id, // CLOUD-0000
          action_type_code: ACTION_TYPE.DISPATCHED,
          hlc_timestamp: evt.hlc_timestamp,
          source_mesh_event_id: evt.id,
          created_at: evt.created_at,
        });
        break;
      }
    }
  }

  return { incidents, responders, history, assignments };
}

/**
 * Stage 5: Confidence derivation
 * Compare last_alive_hlc to current device HLC physical component.
 * Uses a fixed threshold: max(2h, 4 × heartbeat_interval).
 *
 * HLC bounds drift but does not eliminate it.
 * A receiver whose clock runs ahead still sees an inflated delta.
 *
 * @param {Map} incidents - from lwwFold
 * @param {number} currentPhysical - current HLC physical component (epoch ms)
 * @returns {Map} incidents with updated confidence_code
 */
export function deriveConfidence(incidents, currentPhysical) {
  const result = new Map(incidents);

  for (const [id, inc] of result) {
    // Skip if already RESOLVED or CANCELLED
    if (inc.confidence_code === CONFIDENCE.RESOLVED || inc.confidence_code === CONFIDENCE.CANCELLED) {
      continue;
    }

    if (inc.last_alive_hlc) {
      try {
        const { physical: lastAlivePhysical } = parseHlc(inc.last_alive_hlc);
        const delta = currentPhysical - lastAlivePhysical;

        if (delta > CONFIDENCE_THRESHOLD_MS) {
          inc.confidence_code = CONFIDENCE.UNCONFIRMED;
        } else {
          inc.confidence_code = CONFIDENCE.LIVE;
        }
      } catch {
        // If HLC is malformed, default to UNCONFIRMED (safe default)
        inc.confidence_code = CONFIDENCE.UNCONFIRMED;
      }
    } else {
      // No heartbeat ever received - unconfirmed
      inc.confidence_code = CONFIDENCE.UNCONFIRMED;
    }
  }

  return result;
}

/**
 * Full fold pipeline - runs all stages in order.
 *
 * @param {Array} events - all MESH_EVENT rows (the G Set)
 * @param {number} currentPhysical - current HLC physical component
 * @returns {{ incidents: Array, responders: Array, history: Array, assignments: Array }}
 */
export function foldPipeline(events, currentPhysical = Date.now()) {
  // Stage 1: Tombstone filter
  const afterTombstone = tombstoneFilter(events);

  // Stage 2: Heartbeat compaction
  const afterCompaction = heartbeatCompaction(afterTombstone);

  // Stage 3: HLC sort
  const sorted = hlcSort(afterCompaction);

  // Stage 4: LWW fold
  const { incidents, responders, history, assignments } = lwwFold(sorted);

  // Stage 5: Confidence derivation
  const withConfidence = deriveConfidence(incidents, currentPhysical);

  return {
    incidents: Array.from(withConfidence.values()),
    responders: Array.from(responders.values()),
    history,
    assignments: Array.from(assignments.values()),
  };
}