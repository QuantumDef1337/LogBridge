-- ============================================================================
-- Fortigate table dedup migration
-- ============================================================================
-- Root cause: Logstest_middleware.Fortigate has no `event_id` column, so
-- LogBridge's dedup check (SELECT event_id ... WHERE event_id IN (...)) fails
-- with UNKNOWN_IDENTIFIER and silently could not deduplicate. Every overlapping
-- scheduled run re-inserted the same rows.
--
-- Confirmed via:
--   SELECT count() AS total_rows, uniqExact(raw_data) AS unique_logs,
--          count() - uniqExact(raw_data) AS duplicate_rows
--   FROM Logstest_middleware.Fortigate;
--   -> total_rows=78,923,907  unique_logs=72,544,537  duplicate_rows=6,379,370
--
-- This migration rebuilds the table as a ReplacingMergeTree keyed on event_id
-- (an md5 hash of raw_data — matching how LogBridge computes event_id when the
-- dedup field is set to the raw log line), backfills deduplicated data, and
-- swaps it in. Run each step in order and check the row counts before moving on.
-- ============================================================================

-- STEP 0 — PAUSE the FortiGate pipeline in the LogBridge UI before running this.
-- Every run it makes while this migration is in progress adds more duplicates
-- and risks writing into the old table after the swap.

-- STEP 1 — confirm current state (should match the numbers above, or higher).
SELECT
  count()                       AS total_rows,
  uniqExact(raw_data)           AS unique_logs,
  count() - uniqExact(raw_data) AS duplicate_rows
FROM Logstest_middleware.Fortigate;

-- STEP 2 — check the existing table's engine/partitioning so the new one matches.
SHOW CREATE TABLE Logstest_middleware.Fortigate;

-- STEP 3 — create the new table with an event_id column, keyed for dedup.
-- Adjust PARTITION BY if STEP 2 showed a different partitioning scheme.
CREATE TABLE Logstest_middleware.Fortigate_dedup
(
    timestamp      DateTime64(3, 'UTC'),
    ingestion_time DateTime64(3, 'UTC') DEFAULT now64(3),
    event_id       String,
    source         LowCardinality(String),
    customer       LowCardinality(String),
    product        LowCardinality(String),
    action         LowCardinality(String),
    devid          String,
    devname        LowCardinality(String),
    logid          String,
    policyname     String,
    sentbyte       UInt64,
    direction      LowCardinality(String),
    srcip          String,
    dstip          String,
    srcport        UInt32,
    dstport        UInt32,
    subtype        LowCardinality(String),
    srccountry     LowCardinality(String),
    dstcountry     LowCardinality(String),
    service        String,
    hostname       String,
    raw_data       String CODEC(ZSTD(6))
)
ENGINE = ReplacingMergeTree(ingestion_time)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (event_id)
SETTINGS index_granularity = 8192;

-- STEP 4 — backfill, computing event_id as md5(raw_data) — this must match
-- what the LogBridge pipeline will compute going forward (see STEP 8).
INSERT INTO Logstest_middleware.Fortigate_dedup
SELECT
    timestamp, ingestion_time,
    lower(hex(MD5(raw_data))) AS event_id,
    source, customer, product, action, devid, devname, logid, policyname,
    sentbyte, direction, srcip, dstip, srcport, dstport, subtype,
    srccountry, dstcountry, service, hostname, raw_data
FROM Logstest_middleware.Fortigate;

-- STEP 5 — force merge now so duplicates actually collapse (ReplacingMergeTree
-- only dedups on background merge otherwise; FINAL forces it immediately).
OPTIMIZE TABLE Logstest_middleware.Fortigate_dedup FINAL;

-- STEP 6 — verify: this should be close to the unique_logs count from STEP 1
-- (~72.5M), NOT the total_rows count (~78.9M). If it still shows ~78.9M, the
-- OPTIMIZE FINAL did not complete — re-run it before continuing.
SELECT count() FROM Logstest_middleware.Fortigate_dedup;

-- STEP 7 — swap the tables. The old table is kept as a safety net; drop it
-- manually once you've confirmed the new one is correct and stable.
EXCHANGE TABLES Logstest_middleware.Fortigate AND Logstest_middleware.Fortigate_dedup;
-- Fortigate_dedup is now the OLD (duplicate-laden) table; Fortigate is the new
-- clean one and is what the pipeline will write to going forward.

-- STEP 8 — in the LogBridge UI, edit the FortiGate pipeline:
--   Deduplication: enabled
--   Dedup field:   the field holding the raw/full log line (same source as
--                  `raw_data`) — must match what was hashed in STEP 4
--   Dedup algo:    md5
-- This makes the pipeline compute the SAME event_id going forward, so the
-- dedup check against the new event_id column actually catches overlaps.

-- STEP 9 — resume the pipeline. Reconciliation should settle to a small,
-- genuine PARTIAL (a real remaining count, not an ever-shifting excess) as
-- it fills in the last ~500K logs still missing, instead of accumulating
-- more duplicates.

-- STEP 10 (later, once confirmed stable) — reclaim disk space:
-- DROP TABLE Logstest_middleware.Fortigate_dedup;  -- this is the OLD duplicated table after EXCHANGE
