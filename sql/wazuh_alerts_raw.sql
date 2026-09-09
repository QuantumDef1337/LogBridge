-- LogBridge raw test table for Wazuh alerts
-- Flexible schema: stores the whole OpenSearch document as JSON in raw_data,
-- plus the few columns LogBridge auto-injects (customer, product, event_id).
-- Every column has a DEFAULT so partial inserts never fail.

-- If the target database does not exist yet, create it first:
-- CREATE DATABASE IF NOT EXISTS Logs;

CREATE TABLE IF NOT EXISTS Logs.wazuh_alerts_raw
(
    timestamp       DateTime64(3, 'UTC'),
    ingestion_time  DateTime64(3, 'UTC') DEFAULT now64(3),
    customer        LowCardinality(String) DEFAULT '',
    product         LowCardinality(String) DEFAULT '',
    source          String                 DEFAULT '',
    event_id        String                 DEFAULT '',
    raw_data        String CODEC(ZSTD(6))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, event_id)
SETTINGS index_granularity = 8192;
