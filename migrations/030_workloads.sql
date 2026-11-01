-- CPU workloads (2026-11-01): heavy reads that apps make in volume (token cards, pool reports, discovery's payouts) run
-- in "bulk" (src/ch.ts `workload`), everything else in "default". Under contention the scheduler (max-min fair, slot
-- preemption on by default in 26.x) gives bulk a quarter of the CPU and default three quarters; an idle box gives
-- either all of it. Nothing is paused or refused, unlike the `priority` setting. Measured before: the box at load
-- ~36 on 8 threads, two thirds of ClickHouse's query time from the API, and explorer pages queued behind card batches.
-- Undo: DROP WORKLOAD bulk; DROP WORKLOAD default; DROP WORKLOAD all; DROP RESOURCE cpu.
CREATE RESOURCE IF NOT EXISTS cpu (MASTER THREAD, WORKER THREAD);
CREATE WORKLOAD IF NOT EXISTS all;
CREATE WORKLOAD IF NOT EXISTS default IN all SETTINGS weight = 3;
CREATE WORKLOAD IF NOT EXISTS bulk IN all SETTINGS weight = 1;
