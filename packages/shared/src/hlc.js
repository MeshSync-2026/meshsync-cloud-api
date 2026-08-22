// HLC (Hybrid Logical Clock) implementation

// Format: 0001754611200|00042|a3f9c1e7
//          physical(13)  ctr(5)  node(8 hex = 32 bits)

// Total: 13 + 1 + 5 + 1 + 8 = 28 chars
// Lexical string comparison equals causal order (zero padded).

// Node slot is 32 bits (crc32 of node_id), supporting ~65k devices
// before birthday collisions become likely.

import { CLOUD_NODE_ID } from "./enums.js";

// precomputed CRC32 table for performance
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(str) {
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    crc = CRC32_TABLE[(crc ^ str.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Derive the 32 bit node slot from a node_id string.
 * @param {string} nodeId - UUIDv4 or CLOUD-0000
 * @returns {string} 8-char hex string (32 bits)
 */
export function nodeSlot(nodeId) {
  const hash = crc32(nodeId);
  return hash.toString(16).padStart(8, "0");
}

/**
 * Parse an HLC timestamp string into its components.
 * @param {string} hlc - "0001754611200|00042|a3f9c1e7"
 * @returns {{ physical: number, counter: number, node: string }}
 */
export function parseHlc(hlc) {
  if (!hlc || typeof hlc !== "string") {
    throw new Error(`Invalid HLC: ${hlc}`);
  }
  const parts = hlc.split("|");
  if (parts.length !== 3) {
    throw new Error(`Malformed HLC (expected 3 parts): ${hlc}`);
  }
  const physical = parseInt(parts[0], 10);
  const counter = parseInt(parts[1], 10);
  const node = parts[2];
  if (isNaN(physical) || isNaN(counter) || node.length !== 8) {
    throw new Error(`Malformed HLC components: ${hlc}`);
  }
  return { physical, counter, node };
}

/**
 * Format an HLC from components.
 * @param {number} physical - epoch ms (13 digits)
 * @param {number} counter - logical counter (0-99999)
 * @param {string} node - 8-char hex node slot
 * @returns {string} 28 char HLC string
 */
export function formatHlc(physical, counter, node) {
  return `${String(physical).padStart(13, "0")}|${String(counter).padStart(5, "0")}|${node}`;
}

/**
 * Compare two HLC strings lexically.
 * Returns: -1 if a < b, 0 if equal, 1 if a > b
 * HLC is zero padded, lexical comparison equals causal order.
 */
export function compareHlc(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * HLC clock state : persisted across restarts (MMKV on mobile, in memory on cloud).
 */
export class HlcClock {
  constructor(nodeId, state = null) {
    this.nodeId = nodeId;
    this.nodeSlot = nodeSlot(nodeId);
    if (state) {
      this.physical = state.physical || Date.now();
      this.counter = state.counter || 0;
    } else {
      this.physical = Date.now();
      this.counter = 0;
    }
  }

  /**
   * Generate a new HLC timestamp for a local event.
   * Implements the HLC tick algorithm:
   *   l' = max(l, pt_now); if l' == l: c' = c + 1; else c' = 0
   * @returns {string} 28 char HLC string
   */
  tick() {
    const ptNow = Date.now();
    if (ptNow > this.physical) {
      this.physical = ptNow;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return formatHlc(this.physical, this.counter, this.nodeSlot);
  }

  /**
   * Update the HLC upon receiving an event from another node.
   * Implements the HLC receive algorithm:
   *   l' = max(l, pt_now, l_received);
   *   if l' == l and l' == l_received: c' = max(c, c_received) + 1
   *   elif l' == l: c' = c + 1
   *   elif l' == l_received: c' = c_received + 1
   *   else: c' = 0
   * @param {string} receivedHlc - HLC from the received event
   */
  receive(receivedHlc) {
    const { physical: lRecv, counter: cRecv } = parseHlc(receivedHlc);
    const ptNow = Date.now();
    const lNew = Math.max(this.physical, ptNow, lRecv);

    let cNew;
    if (lNew === this.physical && lNew === lRecv) {
      cNew = Math.max(this.counter, cRecv) + 1;
    } else if (lNew === this.physical) {
      cNew = this.counter + 1;
    } else if (lNew === lRecv) {
      cNew = cRecv + 1;
    } else {
      cNew = 0;
    }

    this.physical = lNew;
    this.counter = cNew;
  }

  /**
   * Serialize state for persistence.
   * On mobile: save to MMKV so HLC doesn't regress on restart.
   */
  serialize() {
    return { physical: this.physical, counter: this.counter };
  }

  /**
   * Get the current physical component (for confidence derivation).
   */
  getPhysical() {
    return this.physical;
  }
}

/**
 * Create a cloud HLC clock (uses CLOUD-0000 as node_id).
 */
export function createCloudClock() {
  return new HlcClock(CLOUD_NODE_ID);
}