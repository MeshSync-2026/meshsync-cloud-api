import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateEvent, validateBatch } from "./validation.js";
import { EVENT_TYPE, ACTOR_ROLE, REPORT_TYPE, SEVERITY } from "./enums.js";

describe("Validation — validateEvent", () => {
  const validEvent = {
    id: "evt-0001",
    incident_id: "inc-0001",
    origin_node_id: "device-001",
    seq: 1,
    event_type_code: EVENT_TYPE.SOS_CREATED,
    actor_role_code: ACTOR_ROLE.VICTIM,
    latitude: 6.9271,
    longitude: 79.8612,
    landmark_name: null,
    report_type_code: REPORT_TYPE.SOS,
    category_code: null,
    severity_level: SEVERITY.HIGH,
    status_safety: 0,
    people_count: 1,
    status_water: 0,
    status_injury: 0,
    hlc_timestamp: "0001754611200|00042|a3f9c1e7",
    created_at: Date.now(),
  };

  test("valid event passes", () => {
    const result = validateEvent({ ...validEvent });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test("missing id fails", () => {
    const result = validateEvent({ ...validEvent, id: null });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("id")));
  });

  test("missing origin_node_id fails", () => {
    const result = validateEvent({ ...validEvent, origin_node_id: null });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("origin_node_id")));
  });

  test("invalid event_type_code fails", () => {
    const result = validateEvent({ ...validEvent, event_type_code: 99 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("event_type_code")));
  });

  test("landmark_name over 30 chars is truncated (not rejected)", () => {
    const longName = "A".repeat(50);
    const evt = { ...validEvent, landmark_name: longName };
    const result = validateEvent(evt);
    assert.equal(result.valid, true);
    assert.equal(evt.landmark_name.length, 30);
  });

  test("invalid latitude fails", () => {
    const result = validateEvent({ ...validEvent, latitude: 999 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("latitude")));
  });

  test("ASSIGN event requires target_node_id and target_zone_id", () => {
    const evt = { ...validEvent, event_type_code: EVENT_TYPE.ASSIGN };
    const result = validateEvent(evt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("target_node_id")));
    assert.ok(result.errors.some((e) => e.includes("target_zone_id")));
  });

  test("ASSIGN event with targets passes", () => {
    const evt = { ...validEvent, event_type_code: EVENT_TYPE.ASSIGN, target_node_id: "responder-1", target_zone_id: "zone-001" };
    const result = validateEvent(evt);
    assert.equal(result.valid, true);
  });

  test("malformed HLC fails (wrong length)", () => {
    const result = validateEvent({ ...validEvent, hlc_timestamp: "short" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("hlc_timestamp")));
  });
});

describe("Validation — validateBatch", () => {
  test("separates valid and invalid events", () => {
    const events = [
      { id: "e1", incident_id: "inc-1", origin_node_id: "dev-1", seq: 1, event_type_code: 1, hlc_timestamp: "0001754611200|00042|a3f9c1e7", created_at: Date.now() },
      { id: "e2", incident_id: "inc-1", origin_node_id: null, seq: 2, event_type_code: 1, hlc_timestamp: "0001754611200|00042|a3f9c1e7", created_at: Date.now() },
    ];
    const { valid, invalid } = validateBatch(events);
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].event.id, "e2");
  });
});