// Event priority 
// Priority is DERIVED from event_type_code at send time.
// It is NEVER stored on MESH_EVENT and NEVER transmitted.

// Lower number = higher priority.
// Priority is a transmission ordering hint for constrained satellite links.
// HLC still governs LWW and the fold pipeline.

import { EVENT_TYPE } from "./enums.js";

const PRIORITY_MAP = {
  [EVENT_TYPE.SOS_CREATED]: 0,    // CRITICAL : life safety
  [EVENT_TYPE.SOS_RESOLVED]: 0,   // CRITICAL : life safety
  [EVENT_TYPE.RESPONDER_EN_ROUTE]: 1, // HIGH : operational
  [EVENT_TYPE.STATUS_UPDATE]: 1,      // HIGH : operational
  [EVENT_TYPE.SOS_CANCELLED]: 1,      // HIGH : frees a squad
  [EVENT_TYPE.TOMBSTONE]: 1,          // HIGH : resurrection protection
  [EVENT_TYPE.ASSIGN]: 1,             // HIGH : dispatch order
  [EVENT_TYPE.SOS_ALIVE]: 2,          // NORMAL : heartbeat
};

export const PRIORITY = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
};

export const PRIORITY_LABEL = {
  0: "CRITICAL",
  1: "HIGH",
  2: "NORMAL",
};

/**
 * Derive the priority of an event from its event_type_code.
 * @param {number} eventTypeCode
 * @returns {number} 0=CRITICAL, 1=HIGH, 2=NORMAL
 */
export function derivePriority(eventTypeCode) {
  return PRIORITY_MAP[eventTypeCode] ?? PRIORITY.NORMAL;
}

/**
 * Sort events for transmission over a constrained satellite link.
 * Order: (priority ASC, hlc ASC) , but with aging to prevent starvation.
 *
 * Aging rule: after 2 hours in queue, bump priority by 1 level.After 4 hours, bump again. This prevents NORMAL events from waiting indefinitely behind a stream of CRITICAL/HIGH events.
 *
 * @param {Array<{event_type_code: number, hlc_timestamp: string, created_at: number}>} events
 * @param {number} now - current epoch ms
 * @returns {Array} sorted events
 */
export function sortByPriority(events, now = Date.now()) {
  const AGING_THRESHOLD_1 = 2 * 60 * 60 * 1000; // 2 hours
  const AGING_THRESHOLD_2 = 4 * 60 * 60 * 1000; // 4 hours

  return [...events].sort((a, b) => {
    const ageA = now - (a.created_at || 0);
    const ageB = now - (b.created_at || 0);

    let prioA = derivePriority(a.event_type_code);
    let prioB = derivePriority(b.event_type_code);

    // Aging: bump priority down (lower number = higher priority) with age
    if (ageA > AGING_THRESHOLD_2) prioA = Math.max(0, prioA - 2);
    else if (ageA > AGING_THRESHOLD_1) prioA = Math.max(0, prioA - 1);

    if (ageB > AGING_THRESHOLD_2) prioB = Math.max(0, prioB - 2);
    else if (ageB > AGING_THRESHOLD_1) prioB = Math.max(0, prioB - 1);

    if (prioA !== prioB) return prioA - prioB;
    // Same priority , order by HLC (causal order)
    return a.hlc_timestamp < b.hlc_timestamp ? -1 : a.hlc_timestamp > b.hlc_timestamp ? 1 : 0;
  });
}