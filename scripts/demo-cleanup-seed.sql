-- ============================================================
-- MeshSync demo cleanup + seed data
-- HOW TO RUN: Supabase Dashboard → SQL Editor → New query →
--             paste this whole file → Run
-- Safe to run once. FK-safe delete order (children first).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) BENCHMARK JUNK — 1,000 events/incidents from perf testing
--    (origin_node_id = 'node-bench01')
-- ------------------------------------------------------------
DELETE FROM incident_history
 WHERE source_mesh_event_id IN (SELECT id FROM mesh_event WHERE origin_node_id = 'node-bench01')
    OR incident_id IN (SELECT id FROM incident WHERE creator_node_id = 'node-bench01' OR id LIKE 'bench-%');

DELETE FROM incident_responder
 WHERE incident_id IN (SELECT id FROM incident WHERE creator_node_id = 'node-bench01' OR id LIKE 'bench-%');

DELETE FROM ingestion_batch_item
 WHERE batch_id IN (SELECT id FROM ingestion_batch WHERE uploading_node_id = 'node-bench01');

DELETE FROM incident
 WHERE creator_node_id = 'node-bench01' OR id LIKE 'bench-%';

DELETE FROM mesh_event   WHERE origin_node_id   = 'node-bench01';
DELETE FROM ingestion_batch WHERE uploading_node_id = 'node-bench01';

-- ------------------------------------------------------------
-- 2) FIELD-TEST EVENTS — today's 4-floor building test
--    (4 phone nodes: node-munve7rm / munvdw1d / munvpzfk / munw1ax4)
--    These are real test SOSes. Delete them for a clean dashboard;
--    the screen recordings already captured the proof.
--    Comment this block out if you want to keep them.
-- ------------------------------------------------------------
DELETE FROM incident_history
 WHERE incident_id IN (SELECT id FROM incident WHERE creator_node_id IN
        ('node-munve7rm-g7tl','node-munvdw1d-fw2w','node-munvpzfk-xh0k','node-munw1ax4-1exf'))
    OR actor_node_id IN
        ('node-munve7rm-g7tl','node-munvdw1d-fw2w','node-munvpzfk-xh0k','node-munw1ax4-1exf');

DELETE FROM incident_responder
 WHERE incident_id IN (SELECT id FROM incident WHERE creator_node_id IN
        ('node-munve7rm-g7tl','node-munvdw1d-fw2w','node-munvpzfk-xh0k','node-munw1ax4-1exf'))
    OR responder_node_id IN
        ('node-munve7rm-g7tl','node-munvdw1d-fw2w','node-munvpzfk-xh0k','node-munw1ax4-1exf');

DELETE FROM incident
 WHERE creator_node_id IN
        ('node-munve7rm-g7tl','node-munvdw1d-fw2w','node-munvpzfk-xh0k','node-munw1ax4-1exf');

DELETE FROM mesh_event
 WHERE origin_node_id IN
        ('node-munve7rm-g7tl','node-munvdw1d-fw2w','node-munvpzfk-xh0k','node-munw1ax4-1exf');

-- ------------------------------------------------------------
-- 3) Derived clusters — derived data; dashboard "Recalculate"
--    rebuilds them from remaining incidents.
-- ------------------------------------------------------------
DELETE FROM cluster;

-- ============================================================
-- SEED — small, realistic demo data (5 users, 3 zones, 2 squads)
-- All passwords: Responder123!
-- ============================================================

INSERT INTO response_zone (area_name) VALUES
  ('Zone A — City Centre'),
  ('Zone B — Riverside'),
  ('Zone C — University District');

INSERT INTO authority_user (username, password_hash, full_name, clearance_level, is_active) VALUES
  ('RSP-Kasun', 'scrypt$a26b3b54c9ff059b43c1efc48140afc0$cd13b88127d076d69c7c45983da05fb1cff69e4ba021944383ed420ceb4ba673c0cb6828664ff1c3883cf7e6335f0b92093c8bb67fbee35dd484bd6e75bfb79c', 'Kasun Perera',   'DISPATCHER', true),
  ('RSP-Nimal', 'scrypt$c7b9913bacc5cf4a12b9de98c12496bd$5ac982932420f6f3fa3b08e77634c689691be9630c123a26ba548c7a5bb07ff62130cfafd3c0d83f04269b25f621ce44c1d19fb64e114b60ea59ea873ab2bba2', 'Nimal Silva',    'DISPATCHER', true),
  ('RSP-Sara',  'scrypt$f976a831da6441e0216327b91d79b3ef$68b9eafc729b2a9ec08f6545dffa1617b18031e6641393281101ab0fb279bbc83cbc881a88673a77bf06b050b678a2ebef8a3a359f3680e3f4f19c39e92b8f8e', 'Sara Fernando',  'DISPATCHER', true),
  ('RSP-Dev',   'scrypt$dbe133315d044abccf92f40bc67098a6$6ea1f2e9c0ee302fe7a405a41dab9f091be037c372fc59a7f05f4b0f12de1b45aee6d5a51424bcb402a078ba8640718da1b9e3c124becea9d127b0a67df82f23', 'Dev Rathnayake', 'DISPATCHER', true),
  ('RSP-Amara', 'scrypt$b277041fa1a77453d67edba58de7c802$1ba51b81d04ebfd2058c7f9b3857e794f6403b1ff46d77de056069b997c463f8e9e628c30462b09f7f8fa4dbb0587853e0fe0ce4bacfc5ed2640f9f13dfc0cca', 'Amara Jayasena', 'DISPATCHER', true)
ON CONFLICT (username) DO NOTHING;

INSERT INTO responder_squad (squad_name, leader_authority_user_id, zone_id) VALUES
  ('Alpha Squad',
   (SELECT id FROM authority_user WHERE username='RSP-Kasun'),
   (SELECT id FROM response_zone WHERE area_name='Zone A — City Centre')),
  ('Bravo Squad',
   (SELECT id FROM authority_user WHERE username='RSP-Dev'),
   (SELECT id FROM response_zone WHERE area_name='Zone B — Riverside'));

INSERT INTO squad_member (squad_id, authority_user_id, role_in_squad) VALUES
  ((SELECT id FROM responder_squad WHERE squad_name='Alpha Squad'),
   (SELECT id FROM authority_user WHERE username='RSP-Kasun'), 'LEADER'),
  ((SELECT id FROM responder_squad WHERE squad_name='Alpha Squad'),
   (SELECT id FROM authority_user WHERE username='RSP-Nimal'), 'RESCUER'),
  ((SELECT id FROM responder_squad WHERE squad_name='Alpha Squad'),
   (SELECT id FROM authority_user WHERE username='RSP-Sara'),  'MEDIC'),
  ((SELECT id FROM responder_squad WHERE squad_name='Bravo Squad'),
   (SELECT id FROM authority_user WHERE username='RSP-Dev'),   'LEADER'),
  ((SELECT id FROM responder_squad WHERE squad_name='Bravo Squad'),
   (SELECT id FROM authority_user WHERE username='RSP-Amara'), 'RESCUER')
ON CONFLICT (squad_id, authority_user_id) DO NOTHING;

COMMIT;

-- Verify: SELECT count(*) FROM mesh_event; SELECT count(*) FROM incident;
-- Expect small numbers (0 incidents if you also removed field-test events).
