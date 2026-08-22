// shared enums
// Used by Edge Sync Service, Command Center Service, and Mobile app

export const EVENT_TYPE = {
  SOS_CREATED: 1,
  RESPONDER_EN_ROUTE: 2,
  STATUS_UPDATE: 3,
  SOS_ALIVE: 4,
  SOS_RESOLVED: 5,
  SOS_CANCELLED: 6,
  TOMBSTONE: 7,
  ASSIGN: 8,
};

export const EVENT_TYPE_LABEL = {
  [EVENT_TYPE.SOS_CREATED]: "SOS Created",
  [EVENT_TYPE.RESPONDER_EN_ROUTE]: "Responder En Route",
  [EVENT_TYPE.STATUS_UPDATE]: "Status Update",
  [EVENT_TYPE.SOS_ALIVE]: "SOS Alive",
  [EVENT_TYPE.SOS_RESOLVED]: "SOS Resolved",
  [EVENT_TYPE.SOS_CANCELLED]: "SOS Cancelled",
  [EVENT_TYPE.TOMBSTONE]: "Tombstone",
  [EVENT_TYPE.ASSIGN]: "Assign",
};

export const ACTOR_ROLE = {
  VICTIM: 1,
  CIVILIAN_RESPONDER: 2,
  REGISTERED_RESPONDER: 3,
};

export const REPORT_TYPE = {
  SOS: 1,
  HAZARD: 2,
  STATUS: 3,
};

export const HAZARD_CATEGORY = {
  NONE: 0,
  FLOOD: 1,
  LANDSLIDE: 2,
  STORM: 3,
  FIRE: 4,
  MEDICAL: 5,
  STRUCTURAL: 6,
};

export const SEVERITY = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

export const STATUS = {
  OPEN: 1,
  ASSIGNED: 2,
  EN_ROUTE: 3,
  ON_SCENE: 4,
  RESOLVED: 5,
};

export const CONFIDENCE = {
  LIVE: 1,
  UNCONFIRMED: 2,
  RESOLVED: 3,
  CANCELLED: 4,
};

export const ACTION_TYPE = {
  CREATED: 1,
  SELF_ASSIGNED: 2,
  STATUS_UPDATED: 3,
  CANCELLED: 4,
  RESOLVED: 5,
  ADMIN_OVERRIDE: 6,
  DISPATCHED: 7,
};

export const SAFETY = {
  SAFE: 0,
  NEED_HELP: 1,
  TRAPPED: 2,
};

export const WATER = {
  GOOD: 0,
  LOW: 1,
  NONE: 2,
};

export const INJURY = {
  NONE: 0,
  MINOR: 1,
  SEVERE: 2,
};

export const CLEARANCE = {
  DISPATCHER: "DISPATCHER",
  COMMANDER: "COMMANDER",
};

export const SQUAD_ROLE = {
  LEADER: "LEADER",
  MEDIC: "MEDIC",
  RESCUER: "RESCUER",
  DRIVER: "DRIVER",
  COMMS: "COMMS",
};

export const CLOUD_NODE_ID = "CLOUD-0000";

// Confidence threshold: max(2h, 4 × heartbeat_interval)
// heartbeat_interval = 30 min = 1,800,000 ms
export const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
export const CONFIDENCE_THRESHOLD_MS = Math.max(2 * 60 * 60 * 1000, 4 * HEARTBEAT_INTERVAL_MS); // 2 hours

// Retention windows
export const TOMBSTONE_RETENTION_DAYS = 7;
export const BODY_RETENTION_HOURS = 48;
export const DEDUP_WINDOW_DAYS = 7;
export const PROCESSED_BROADCAST_LRU_CAP = 100000;

// TTL for BLE broadcast (seconds)
export const BLE_TTL_SECONDS = 300;
export const BLE_HOP_COUNT = 5;
export const BLE_MTU = 512;
export const BLE_DUTY_CYCLE_ADVERTISING_MS = 3000;
export const BLE_DUTY_CYCLE_WINDOW_MS = 12000;