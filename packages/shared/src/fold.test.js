import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  foldPipeline,
  tombstoneFilter,
  heartbeatCompaction,
  hlcSort,
  lwwFold,
  deriveConfidence,
} from "./fold.js";
import {
  EVENT_TYPE,
  STATUS,
  CONFIDENCE,
  ACTOR_ROLE,
  REPORT_TYPE,
  SEVERITY,
} from "./enums.js";
import { formatHlc, nodeSlot } from "./hlc.js";

// Helper to create a minimal event
let eventCounter = 0;
function makeEvent(overrides = {}) {
  eventCounter++;
  const nodeId = overrides.origin_node_id || "device-001";
  const physical = overrides.created_at || Date.now();
  return {
    id: `evt-${String(eventCounter).padStart(4, "0")}`,
    parent_id: null,
    incident_id: "inc-0001",
    origin_node_id: nodeId,
    seq: eventCounter,
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
    target_node_id: null,
    target_zone_id: null,
    hlc_timestamp: formatHlc(physical, eventCounter, nodeSlot(nodeId)),
    created_at: physical,
    ...overrides,
  };
}

describe("Fold — tombstoneFilter", () => {
  test("drops events for tombstoned incidents", () => {
    const events = [
      makeEvent({ id: "e1", hlc_timestamp: formatHlc(1000, 0, "00000001") }),
      makeEvent({ id: "e2", event_type_code: EVENT_TYPE.TOMBSTONE, hlc_timestamp: formatHlc(2000, 0, "00000001") }),
      makeEvent({ id: "e3", hlc_timestamp: formatHlc(1500, 0, "00000001") }), // between e1 and e2
      makeEvent({ id: "e4", hlc_timestamp: formatHlc(3000, 0, "00000001") }), // after tombstone — kept (newer)
    ];
    const result = tombstoneFilter(events);
    // e1 (hlc 1000 <= 2000) dropped, e2 (tombstone itself) kept, e3 (1500 <= 2000) dropped, e4 (3000 > 2000) kept
    assert.equal(result.length, 2);
    assert.ok(result.find((e) => e.id === "e2"));
    assert.ok(result.find((e) => e.id === "e4"));
  });

  test("keeps all events if no tombstones", () => {
    const events = [makeEvent({ id: "e1" }), makeEvent({ id: "e2" })];
    const result = tombstoneFilter(events);
    assert.equal(result.length, 2);
  });
});

describe("Fold — heartbeatCompaction", () => {
  test("keeps only latest SOS_ALIVE per (incident_id, origin_node_id)", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_ALIVE, hlc_timestamp: formatHlc(1000, 0, "00000001") }),
      makeEvent({ id: "e2", event_type_code: EVENT_TYPE.SOS_ALIVE, hlc_timestamp: formatHlc(2000, 0, "00000001") }),
      makeEvent({ id: "e3", event_type_code: EVENT_TYPE.SOS_ALIVE, hlc_timestamp: formatHlc(3000, 0, "00000001") }),
      makeEvent({ id: "e4", event_type_code: EVENT_TYPE.SOS_CREATED }),
    ];
    const result = heartbeatCompaction(events);
    const aliveEvents = result.filter((e) => e.event_type_code === EVENT_TYPE.SOS_ALIVE);
    assert.equal(aliveEvents.length, 1, "should keep only 1 SOS_ALIVE");
    assert.equal(aliveEvents[0].id, "e3", "should keep the latest one");
  });

  test("keeps heartbeats from different origins", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_ALIVE, origin_node_id: "dev-A", hlc_timestamp: formatHlc(1000, 0, nodeSlot("dev-A")) }),
      makeEvent({ id: "e2", event_type_code: EVENT_TYPE.SOS_ALIVE, origin_node_id: "dev-B", hlc_timestamp: formatHlc(2000, 0, nodeSlot("dev-B")) }),
    ];
    const result = heartbeatCompaction(events);
    assert.equal(result.length, 2, "different origins both kept");
  });
});

describe("Fold — hlcSort", () => {
  test("sorts by HLC lexically", () => {
    const events = [
      makeEvent({ id: "e3", hlc_timestamp: formatHlc(3000, 0, "00000001") }),
      makeEvent({ id: "e1", hlc_timestamp: formatHlc(1000, 0, "00000001") }),
      makeEvent({ id: "e2", hlc_timestamp: formatHlc(2000, 0, "00000001") }),
    ];
    const sorted = hlcSort(events);
    assert.equal(sorted[0].id, "e1");
    assert.equal(sorted[1].id, "e2");
    assert.equal(sorted[2].id, "e3");
  });
});

describe("Fold — lwwFold", () => {
  test("creates incident from SOS_CREATED", () => {
    const events = [makeEvent({ event_type_code: EVENT_TYPE.SOS_CREATED })];
    const { incidents } = lwwFold(events);
    assert.equal(incidents.size, 1);
    const inc = incidents.get("inc-0001");
    assert.equal(inc.status_code, STATUS.OPEN);
    assert.equal(inc.confidence_code, CONFIDENCE.LIVE);
    assert.equal(inc.severity_level, SEVERITY.HIGH);
  });

  test("adds responder on RESPONDER_EN_ROUTE", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, origin_node_id: "victim-1" }),
      makeEvent({
        id: "e2",
        event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE,
        origin_node_id: "responder-1",
        actor_role_code: ACTOR_ROLE.CIVILIAN_RESPONDER,
        hlc_timestamp: formatHlc(2000, 0, nodeSlot("responder-1")),
      }),
    ];
    const { incidents, responders, history } = lwwFold(events);
    assert.equal(responders.size, 1);
    assert.equal(incidents.get("inc-0001").status_code, STATUS.EN_ROUTE);
    assert.ok(history.length >= 2);
  });

  test("resolves incident on SOS_RESOLVED", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED }),
      makeEvent({ id: "e2", event_type_code: EVENT_TYPE.SOS_RESOLVED, hlc_timestamp: formatHlc(2000, 0, "00000001") }),
    ];
    const { incidents } = lwwFold(events);
    const inc = incidents.get("inc-0001");
    assert.equal(inc.status_code, STATUS.RESOLVED);
    assert.equal(inc.confidence_code, CONFIDENCE.RESOLVED);
  });

  test("cancels incident on SOS_CANCELLED", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED }),
      makeEvent({ id: "e2", event_type_code: EVENT_TYPE.SOS_CANCELLED, hlc_timestamp: formatHlc(2000, 0, "00000001") }),
    ];
    const { incidents } = lwwFold(events);
    const inc = incidents.get("inc-0001");
    assert.equal(inc.confidence_code, CONFIDENCE.CANCELLED);
  });

  test("Creator Override — heartbeat reopens resolved incident", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, origin_node_id: "victim-1" }),
      makeEvent({ id: "e2", event_type_code: EVENT_TYPE.SOS_RESOLVED, hlc_timestamp: formatHlc(2000, 0, "00000001") }),
      makeEvent({
        id: "e3",
        event_type_code: EVENT_TYPE.SOS_ALIVE,
        origin_node_id: "victim-1",
        hlc_timestamp: formatHlc(3000, 0, nodeSlot("victim-1")),
      }),
    ];
    const { incidents } = lwwFold(events);
    const inc = incidents.get("inc-0001");
    assert.equal(inc.confidence_code, CONFIDENCE.LIVE, "heartbeat should reopen");
    assert.equal(inc.status_code, STATUS.OPEN);
  });

  test("LWW — later event overwrites earlier field values", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, severity_level: SEVERITY.LOW }),
      makeEvent({
        id: "e2",
        event_type_code: EVENT_TYPE.STATUS_UPDATE,
        severity_level: SEVERITY.HIGH,
        hlc_timestamp: formatHlc(2000, 0, "00000001"),
      }),
    ];
    const { incidents } = lwwFold(events);
    assert.equal(incidents.get("inc-0001").severity_level, SEVERITY.HIGH);
  });

  test("projects MESH_ASSIGNMENT from ASSIGN events", () => {
    const events = [
      makeEvent({
        id: "e1",
        event_type_code: EVENT_TYPE.ASSIGN,
        origin_node_id: "CLOUD-0000",
        target_node_id: "responder-1",
        target_zone_id: "zone-001",
        hlc_timestamp: formatHlc(1000, 0, nodeSlot("CLOUD-0000")),
      }),
    ];
    const { assignments } = lwwFold(events);
    assert.equal(assignments.size, 1);
    const a = assignments.get("responder-1|zone-001");
    assert.equal(a.responder_node_id, "responder-1");
    assert.equal(a.zone_id, "zone-001");
  });

  test("concurrent responders both preserved (§4)", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, origin_node_id: "victim-1" }),
      makeEvent({
        id: "e2",
        event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE,
        origin_node_id: "responder-A",
        hlc_timestamp: formatHlc(2000, 0, nodeSlot("responder-A")),
      }),
      makeEvent({
        id: "e3",
        event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE,
        origin_node_id: "responder-B",
        hlc_timestamp: formatHlc(2000, 0, nodeSlot("responder-B")),
      }),
    ];
    const { responders } = lwwFold(events);
    assert.equal(responders.size, 2, "both responders preserved");
  });
});

describe("Fold — deriveConfidence", () => {
  test("live incident with recent heartbeat → LIVE", () => {
    const now = Date.now();
    const incidents = new Map([
      ["inc-1", {
        id: "inc-1",
        confidence_code: CONFIDENCE.LIVE,
        last_alive_hlc: formatHlc(now - 60000, 0, "00000001"), // 1 min ago
        status_code: STATUS.OPEN,
      }],
    ]);
    const result = deriveConfidence(incidents, now);
    assert.equal(result.get("inc-1").confidence_code, CONFIDENCE.LIVE);
  });

  test("incident with stale heartbeat → UNCONFIRMED", () => {
    const now = Date.now();
    const threeHoursAgo = now - 3 * 60 * 60 * 1000;
    const incidents = new Map([
      ["inc-1", {
        id: "inc-1",
        confidence_code: CONFIDENCE.LIVE,
        last_alive_hlc: formatHlc(threeHoursAgo, 0, "00000001"),
        status_code: STATUS.OPEN,
      }],
    ]);
    const result = deriveConfidence(incidents, now);
    assert.equal(result.get("inc-1").confidence_code, CONFIDENCE.UNCONFIRMED);
  });

  test("resolved incident stays RESOLVED regardless of heartbeat age", () => {
    const now = Date.now();
    const incidents = new Map([
      ["inc-1", {
        id: "inc-1",
        confidence_code: CONFIDENCE.RESOLVED,
        last_alive_hlc: formatHlc(now - 999999999, 0, "00000001"),
        status_code: STATUS.RESOLVED,
      }],
    ]);
    const result = deriveConfidence(incidents, now);
    assert.equal(result.get("inc-1").confidence_code, CONFIDENCE.RESOLVED);
  });
});

describe("Fold — full pipeline", () => {
  test("end-to-end: SOS → responder → resolve", () => {
    const events = [
      makeEvent({ id: "e1", event_type_code: EVENT_TYPE.SOS_CREATED, origin_node_id: "victim-1", hlc_timestamp: formatHlc(1000, 0, nodeSlot("victim-1")) }),
      makeEvent({ id: "e2", event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE, origin_node_id: "responder-1", hlc_timestamp: formatHlc(2000, 0, nodeSlot("responder-1")) }),
      makeEvent({ id: "e3", event_type_code: EVENT_TYPE.SOS_RESOLVED, origin_node_id: "responder-1", hlc_timestamp: formatHlc(3000, 0, nodeSlot("responder-1")) }),
    ];
    const result = foldPipeline(events, 4000);
    assert.equal(result.incidents.length, 1);
    assert.equal(result.incidents[0].status_code, STATUS.RESOLVED);
    assert.equal(result.responders.length, 1);
    assert.ok(result.history.length >= 3);
  });
});