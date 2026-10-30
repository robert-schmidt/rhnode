-- A retried insert (ingest or the history pass, same token) reaches these tables through native_edges' views; without a
-- deduplication window it is summed again and `total` doubles (tested 2026-10-30 on a scratch database: 1,000 edges
-- written twice gave twice the wei; with the window, the same). n, peers, first_block and last_block were already safe.
ALTER TABLE agg_native_src MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE agg_native_dst MODIFY SETTING non_replicated_deduplication_window = 10000;
