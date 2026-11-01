-- Priorities under contention (2026-11-01): 1. the node keeping up with the chain, 2. priority API keys, 3. everything
-- else. "default" (untagged: ingest, projector) weight 8; "apps" weight 4 for API keys in API_PRIORITY, split light
-- (charts, /rpc, /health: weight 3) before heavy (cards, pool reports: weight 1); "bulk" weight 1 (other keys, the
-- explorer, the history pass, promotion, discovery). Fully contended: ~62% / 31% / 8%; idle shares go to whoever wants
-- them, and nothing is paused (weights, not `priority`). The OS side is compose.yaml's cpu_shares.
-- Undo: DROP WORKLOAD apps_light; DROP WORKLOAD apps_heavy; DROP WORKLOAD apps; CREATE OR REPLACE WORKLOAD default IN all SETTINGS weight = 3.
CREATE OR REPLACE WORKLOAD default IN all SETTINGS weight = 8;
CREATE WORKLOAD IF NOT EXISTS apps IN all SETTINGS weight = 4;
CREATE WORKLOAD IF NOT EXISTS apps_light IN apps SETTINGS weight = 3;
CREATE WORKLOAD IF NOT EXISTS apps_heavy IN apps SETTINGS weight = 1;
