// Event validation 
// Validates incoming MESH_EVENT payloads from Data Mules.
// Rejects gracefully (per row, not per batch) so one bad row doesn't fail the entire ingestion batch.

import { EVENT_TYPE, ACTOR_ROLE, REPORT_TYPE, SEVERITY, SAFETY, WATER, INJURY } from "./enums.js";

const MAX_LANDMARK_LENGTH = 30;
const MAX_LAT = 90;
const MIN_LAT = -90;
const MAX_LNG = 180;
const MIN_LNG = -180;
const MAX_PEOPLE_COUNT = 100000;

/**
 * Validate a single MESH_EVENT payload.
 * @param {object} evt - the event to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEvent(evt) {
  const errors = [];

  // Shape guard — a null/non-object row must reject, not throw
  if (!evt || typeof evt !== "object" || Array.isArray(evt)) {
    return { valid: false, errors: ["event must be an object"] };
  }

  // Required fields
  if (!evt.id || typeof evt.id !== "string") {
    errors.push("id is required and must be a string (UUIDv4)");
  }
  if (!evt.incident_id || typeof evt.incident_id !== "string") {
    errors.push("incident_id is required and must be a string");
  }
  if (!evt.origin_node_id || typeof evt.origin_node_id !== "string") {
    errors.push("origin_node_id is required and must be a string (text, not uuid)");
  }
  if (!evt.hlc_timestamp || typeof evt.hlc_timestamp !== "string") {
    errors.push("hlc_timestamp is required and must be a string");
  } else if (!/^\d{13}\|\d{5}\|[0-9a-f]{8}$/.test(evt.hlc_timestamp)) {
    errors.push(`hlc_timestamp must match "<13-digit-ms>|<5-digit-counter>|<8-hex-node>"`);
  }
  if (typeof evt.event_type_code !== "number" || evt.event_type_code < 1 || evt.event_type_code > 8) {
    errors.push("event_type_code must be a number 1-8");
  }
  if (!Number.isInteger(evt.seq) || evt.seq < 0) {
    errors.push("seq must be a non-negative integer");
  }

  // Optional but validated if present
  if (evt.actor_role_code != null) {
    if (![ACTOR_ROLE.VICTIM, ACTOR_ROLE.CIVILIAN_RESPONDER, ACTOR_ROLE.REGISTERED_RESPONDER].includes(evt.actor_role_code)) {
      errors.push("actor_role_code must be 1, 2, or 3");
    }
  }
  if (evt.report_type_code != null) {
    if (![REPORT_TYPE.SOS, REPORT_TYPE.HAZARD, REPORT_TYPE.STATUS].includes(evt.report_type_code)) {
      errors.push("report_type_code must be 1, 2, or 3");
    }
  }
  if (evt.severity_level != null) {
    if (![SEVERITY.LOW, SEVERITY.MEDIUM, SEVERITY.HIGH, SEVERITY.VERY_HIGH].includes(evt.severity_level)) {
      errors.push("severity_level must be 1, 2, 3, or 4");
    }
  }
  if (evt.status_safety != null) {
    if (![SAFETY.SAFE, SAFETY.NEED_HELP, SAFETY.TRAPPED].includes(evt.status_safety)) {
      errors.push("status_safety must be 0, 1, or 2");
    }
  }
  if (evt.status_water != null) {
    if (![WATER.GOOD, WATER.LOW, WATER.NONE].includes(evt.status_water)) {
      errors.push("status_water must be 0, 1, or 2");
    }
  }
  if (evt.status_injury != null) {
    if (![INJURY.NONE, INJURY.MINOR, INJURY.SEVERE].includes(evt.status_injury)) {
      errors.push("status_injury must be 0, 1, or 2");
    }
  }

  // Lat/lng validation
  if (evt.latitude != null) {
    if (typeof evt.latitude !== "number" || evt.latitude < MIN_LAT || evt.latitude > MAX_LAT) {
      errors.push("latitude must be a number between -90 and 90");
    }
  }
  if (evt.longitude != null) {
    if (typeof evt.longitude !== "number" || evt.longitude < MIN_LNG || evt.longitude > MAX_LNG) {
      errors.push("longitude must be a number between -180 and 180");
    }
  }

  // Landmark name - hard cap 30 chars
  if (evt.landmark_name != null) {
    if (typeof evt.landmark_name !== "string") {
      errors.push("landmark_name must be a string");
    } else if (evt.landmark_name.length > MAX_LANDMARK_LENGTH) {
      // Truncate rather than reject - "truncated at input, not at send time"
      evt.landmark_name = evt.landmark_name.substring(0, MAX_LANDMARK_LENGTH);
    }
  }

  // People count
  if (evt.people_count != null) {
    if (typeof evt.people_count !== "number" || evt.people_count < 0 || evt.people_count > MAX_PEOPLE_COUNT) {
      errors.push("people_count must be a non-negative number");
    }
  }

  // ASSIGN-specific fields (event_type_code=8)
  if (evt.event_type_code === EVENT_TYPE.ASSIGN) {
    if (!evt.target_node_id) {
      errors.push("target_node_id is required for ASSIGN events");
    }
    if (!evt.target_zone_id) {
      errors.push("target_zone_id is required for ASSIGN events");
    }
  }

  // created_at - device-origin, must be a valid timestamp
  if (evt.created_at == null || !Number.isFinite(evt.created_at) || evt.created_at <= 0) {
    errors.push("created_at is required (device-origin epoch ms)");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a batch of events, separating valid from invalid.
 * @param {Array} events
 * @returns {{ valid: Array, invalid: Array<{ event: object, errors: string[] }> }}
 */
export function validateBatch(events) {
  const valid = [];
  const invalid = [];

  for (const evt of events) {
    const result = validateEvent(evt);
    if (result.valid) {
      valid.push(evt);
    } else {
      invalid.push({ event: evt, errors: result.errors });
    }
  }

  return { valid, invalid };
}