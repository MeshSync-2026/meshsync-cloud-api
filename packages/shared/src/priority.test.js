import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { derivePriority, sortByPriority, PRIORITY } from "./priority.js";
import { EVENT_TYPE } from "./enums.js";
import { formatHlc, nodeSlot } from "./hlc.js";

describe("Priority — derivePriority", () => {
  test("SOS_CREATED is CRITICAL (0)", () => {
    assert.equal(derivePriority(EVENT_TYPE.SOS_CREATED), PRIORITY.CRITICAL);
  });

  test("SOS_RESOLVED is CRITICAL (0)", () => {
    assert.equal(derivePriority(EVENT_TYPE.SOS_RESOLVED), PRIORITY.CRITICAL);
  });

  test("TOMBSTONE is HIGH (1) — not LOW", () => {
    assert.equal(derivePriority(EVENT_TYPE.TOMBSTONE), PRIORITY.HIGH);
  });

  test("SOS_CANCELLED is HIGH (1) — not LOW", () => {
    assert.equal(derivePriority(EVENT_TYPE.SOS_CANCELLED), PRIORITY.HIGH);
  });

  test("ASSIGN is HIGH (1)", () => {
    assert.equal(derivePriority(EVENT_TYPE.ASSIGN), PRIORITY.HIGH);
  });

  test("SOS_ALIVE is NORMAL (2)", () => {
    assert.equal(derivePriority(EVENT_TYPE.SOS_ALIVE), PRIORITY.NORMAL);
  });

  test("RESPONDER_EN_ROUTE is HIGH (1)", () => {
    assert.equal(derivePriority(EVENT_TYPE.RESPONDER_EN_ROUTE), PRIORITY.HIGH);
  });
});

describe("Priority — sortByPriority", () => {
  test("CRITICAL events come before HIGH before NORMAL", () => {
    const now = Date.now();
    const events = [
      { event_type_code: EVENT_TYPE.SOS_ALIVE, hlc_timestamp: formatHlc(1000, 0, "00000001"), created_at: now },
      { event_type_code: EVENT_TYPE.SOS_CREATED, hlc_timestamp: formatHlc(2000, 0, "00000001"), created_at: now },
      { event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE, hlc_timestamp: formatHlc(3000, 0, "00000001"), created_at: now },
    ];
    const sorted = sortByPriority(events, now);
    assert.equal(sorted[0].event_type_code, EVENT_TYPE.SOS_CREATED); // CRITICAL first
    assert.equal(sorted[1].event_type_code, EVENT_TYPE.RESPONDER_EN_ROUTE); // HIGH second
    assert.equal(sorted[2].event_type_code, EVENT_TYPE.SOS_ALIVE); // NORMAL last
  });

  test("same priority — ordered by HLC", () => {
    const now = Date.now();
    const events = [
      { event_type_code: EVENT_TYPE.SOS_CREATED, hlc_timestamp: formatHlc(3000, 0, "00000001"), created_at: now },
      { event_type_code: EVENT_TYPE.SOS_RESOLVED, hlc_timestamp: formatHlc(1000, 0, "00000001"), created_at: now },
    ];
    const sorted = sortByPriority(events, now);
    // Both CRITICAL, so sort by HLC
    assert.equal(sorted[0].hlc_timestamp, formatHlc(1000, 0, "00000001"));
    assert.equal(sorted[1].hlc_timestamp, formatHlc(3000, 0, "00000001"));
  });

  test("aging bumps old NORMAL events to HIGH after 2h", () => {
    const now = Date.now();
    const twoAndHalfHoursAgo = now - 2.5 * 60 * 60 * 1000;
    const events = [
      { event_type_code: EVENT_TYPE.SOS_ALIVE, hlc_timestamp: formatHlc(1000, 0, "00000001"), created_at: twoAndHalfHoursAgo },
      { event_type_code: EVENT_TYPE.RESPONDER_EN_ROUTE, hlc_timestamp: formatHlc(2000, 0, "00000001"), created_at: now },
    ];
    const sorted = sortByPriority(events, now);
    // SOS_ALIVE aged from NORMAL(2) to HIGH(1), same as RESPONDER_EN_ROUTE
    // Same priority → sort by HLC → SOS_ALIVE (1000) first
    assert.equal(sorted[0].event_type_code, EVENT_TYPE.SOS_ALIVE);
  });
});