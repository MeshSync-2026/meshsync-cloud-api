BEGIN;

CREATE TABLE IF NOT EXISTS mesh_event (
    id              text PRIMARY KEY,          -- UUIDv4 from device, same across replicas
    parent_id       text,                      -- nullable causal tree link
    incident_id     text NOT NULL,             -- groups events into one incident
    origin_node_id  text NOT NULL,             -- emitting device (text, not uuid)
    seq             bigint NOT NULL,           -- monotonic per node
    event_type_code integer NOT NULL,          -- 1-8
    actor_role_code integer,                   -- 1=Victim 2=Civilian 3=Registered (metadata only)
    latitude        double precision,
    longitude       double precision,
    landmark_name   text,                      -- nullable, hard cap 30 chars
    report_type_code integer,                  -- 1=SOS 2=HAZARD 3=STATUS
    category_code   integer,                   -- nullable 1=Flood 2=Landslide 3=Fire 4=Structural
    severity_level  integer,                   -- 1=Low 2=Medium 3=High
    status_safety   integer,                   -- 0=Safe 1=NeedHelp 2=Trapped
    people_count    integer,
    status_water    integer,                   -- 0=Good 1=Low 2=None
    status_injury   integer,                   -- 0=None 1=Minor 2=Severe
    target_node_id  text,                      -- nullable, only for ASSIGN (event_type_code=8)
    target_zone_id  text,                      -- nullable, only for ASSIGN
    hlc_timestamp   text NOT NULL,             -- 28 char zero padded lexically sortable
    created_at      timestamptz NOT NULL,      -- device origin, NO DEFAULT
    first_ingested_at timestamptz DEFAULT now()    
);

CREATE INDEX idx_mesh_event_incident ON mesh_event (incident_id);
CREATE INDEX idx_mesh_event_hlc ON mesh_event (hlc_timestamp);
CREATE INDEX idx_mesh_event_origin_seq ON mesh_event (origin_node_id, seq);
CREATE INDEX idx_mesh_event_type ON mesh_event (event_type_code);
CREATE INDEX idx_mesh_event_incident_hlc ON mesh_event (incident_id, hlc_timestamp);

CREATE TABLE IF NOT EXISTS incident (
    id              text PRIMARY KEY,          -- same UUID across all replicas
    creator_node_id text NOT NULL,
    zone_id         uuid,                      -- nullable, dispatcher assigned
    cluster_id      uuid,                      -- nullable, auto computed ON DELETE SET NULL
    latitude        double precision,
    longitude       double precision,
    landmark_name   text,
    report_type_code integer,
    category_code   integer,
    severity_level  integer,
    status_code     integer NOT NULL DEFAULT 1, -- 1=OPEN 2=ASSIGNED 3=EN_ROUTE 4=ON_SCENE 5=RESOLVED
    confidence_code integer NOT NULL DEFAULT 1, -- 1=Live 2=Unconfirmed 3=Resolved 4=Cancelled
    status_safety   integer,
    people_count    integer,
    status_water    integer,
    status_injury   integer,
    last_heartbeat_at timestamptz,             -- UI display only; confidence uses HLC
    last_alive_hlc  text,                      -- latest SOS_ALIVE HLC drives confidence
    last_event_hlc  text,
    is_cloud_synced boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL,      -- device origin
    updated_at      timestamptz NOT NULL,      -- device origin
    first_ingested_at timestamptz DEFAULT now()
);

CREATE INDEX idx_incident_cluster_status ON incident (cluster_id, status_code);
CREATE INDEX idx_incident_zone ON incident (zone_id);
CREATE INDEX idx_incident_created ON incident (created_at DESC);
CREATE INDEX idx_incident_confidence ON incident (confidence_code);

CREATE TABLE IF NOT EXISTS incident_responder (
    id                  text PRIMARY KEY,
    incident_id         text NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    responder_node_id   text NOT NULL,
    actor_role_code     integer,
    hlc_timestamp       text NOT NULL,
    joined_at           timestamptz NOT NULL
);

CREATE INDEX idx_responder_incident ON incident_responder (incident_id);
CREATE INDEX idx_responder_node ON incident_responder (responder_node_id);

CREATE TABLE IF NOT EXISTS incident_history (
    id                      text PRIMARY KEY,
    incident_id             text NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    actor_node_id           text,              -- nullable, mesh user
    actor_admin_id          uuid,              -- nullable, cloud admin
    action_type_code        integer NOT NULL,  -- 1=CREATED 2=SELF_ASSIGNED 3=STATUS_UPDATED 4=CANCELLED 5=RESOLVED 6=ADMIN_OVERRIDE 7=DISPATCHED
    hlc_timestamp           text,
    source_mesh_event_id    text,              -- nullable FK to MESH_EVENT when derived from log
    created_at              timestamptz NOT NULL -- device origin
);

CREATE INDEX idx_history_incident ON incident_history (incident_id);
CREATE INDEX idx_history_action ON incident_history (action_type_code);

CREATE TABLE IF NOT EXISTS authority_user (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username            text UNIQUE NOT NULL,
    password_hash       text NOT NULL,         -- bcrypt
    full_name           text,
    clearance_level     text NOT NULL DEFAULT 'DISPATCHER', -- DISPATCHER or COMMANDER
    assigned_cluster_id uuid,                  -- nullable, null = all clusters
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registered_device (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id             text UNIQUE NOT NULL,  -- from device MMKV
    authority_user_id   uuid NOT NULL REFERENCES authority_user(id) ON DELETE CASCADE,
    is_active           boolean NOT NULL DEFAULT true, -- revocation applies on next reconnect
    registered_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz
);

CREATE INDEX idx_device_user ON registered_device (authority_user_id);
CREATE INDEX idx_device_active ON registered_device (is_active);

CREATE TABLE IF NOT EXISTS cluster (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    centroid_lat        double precision,
    centroid_lng        double precision,
    radius_meters       double precision,      -- Haversine to furthest member
    severity_score      double precision,      -- aggregated from members
    incident_count      integer NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'ACTIVE', -- ACTIVE or RESOLVED
    resolved_by_admin_id uuid REFERENCES authority_user(id), -- COMMANDER only
    resolved_at         timestamptz,
    last_recalculated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS response_zone (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_name   text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mesh_assignment (
    id                      text PRIMARY KEY,
    responder_node_id       text NOT NULL,
    zone_id                 uuid NOT NULL REFERENCES response_zone(id) ON DELETE CASCADE,
    assigned_by_admin_id    uuid REFERENCES authority_user(id),
    hlc_timestamp           text NOT NULL,     -- cloud generated with CLOUD-0000
    assigned_at             timestamptz NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_assignment_responder ON mesh_assignment (responder_node_id);
CREATE INDEX idx_assignment_zone ON mesh_assignment (zone_id);

CREATE TABLE IF NOT EXISTS responder_squad (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_name                  text NOT NULL,
    leader_authority_user_id    uuid NOT NULL REFERENCES authority_user(id),
    zone_id                     uuid REFERENCES response_zone(id), -- nullable = unassigned
    is_active                   boolean NOT NULL DEFAULT true,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_squad_leader ON responder_squad (leader_authority_user_id);
CREATE INDEX idx_squad_zone ON responder_squad (zone_id);

CREATE TABLE IF NOT EXISTS squad_member (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    squad_id            uuid NOT NULL REFERENCES responder_squad(id) ON DELETE CASCADE,
    authority_user_id   uuid NOT NULL REFERENCES authority_user(id) ON DELETE CASCADE,
    role_in_squad       text NOT NULL DEFAULT 'RESCUER', -- LEADER, MEDIC, RESCUER, DRIVER, COMMS
    joined_at           timestamptz NOT NULL DEFAULT now(),
    is_active           boolean NOT NULL DEFAULT true,
    UNIQUE (squad_id, authority_user_id)
);

CREATE INDEX idx_member_squad ON squad_member (squad_id);
CREATE INDEX idx_member_user ON squad_member (authority_user_id);


CREATE TABLE IF NOT EXISTS ingestion_batch (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    uploading_node_id   text NOT NULL,         -- Data Mule node_id
    received_at         timestamptz NOT NULL DEFAULT now(),
    new_count           integer NOT NULL DEFAULT 0,
    updated_count       integer NOT NULL DEFAULT 0,
    duplicate_count     integer NOT NULL DEFAULT 0,
    rejected_count      integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingestion_batch_item (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id    uuid NOT NULL REFERENCES ingestion_batch(id) ON DELETE CASCADE,
    table_name  text NOT NULL,                 -- MESH_EVENT or INCIDENT_HISTORY
    row_id      text,                          -- nullable (null when payload malformed)
    outcome     text NOT NULL,                 -- inserted, updated, duplicate_ignored, rejected
    error_detail text                          -- nullable, why rejected
);

CREATE INDEX idx_batch_item_batch ON ingestion_batch_item (batch_id);

CREATE TABLE IF NOT EXISTS satellite_uplink (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    uplink_name     text NOT NULL,             -- "Iridium Garage", "Starlink Base"
    uplink_type     text NOT NULL,             -- IRIDIUM, GARMIN, STARLINK
    is_connected    boolean NOT NULL DEFAULT false,
    bandwidth_kbps  integer,                   -- estimated available bandwidth
    queue_depth_critical integer NOT NULL DEFAULT 0,
    queue_depth_high     integer NOT NULL DEFAULT 0,
    queue_depth_normal   integer NOT NULL DEFAULT 0,
    last_sync_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);


COMMIT;

-- NOTE Handle in application logic: creator_node_id is nullable to allow placeholder incident creation if child events arrive out of order; the fold engine will update it when SOS_CREATED arrives.
