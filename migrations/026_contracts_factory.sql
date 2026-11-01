-- The contracts feed with tip traces (2026-11-01). 013's "a factory-made contract is only seen once it emits" no longer
-- holds where we trace: creations (024) has every CREATE/CREATE2 frame, and 85% of new contracts come from a factory
-- (measured 2026-11-01: 18,807 of 22,091 in a day; 8,427 never emitted a log, so the feed never showed them).
-- * created = 1 now also covers a factory-made contract (a creation frame in a successful tx); deployer stays the tx
--   sender and factory is the frame's creator ('' for a tx's own deployment).
-- * first_of_kind = 1 only on a contract we saw created: one first seen by a log may be months old (46% of the ERC-20s
--   seen that way since go-live were minted before it), so it marks its fingerprint as seen without being "first".
-- src/projector/contracts.ts writes it; the rows from before this migration are redone by src/tools/contracts-redo.ts.
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS factory String AFTER deployer;
