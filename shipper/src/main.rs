use anyhow::{Context, Result};
use chrono::Utc;
use md5::{Digest as Md5Digest, Md5};
use reqwest::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest as Sha2Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tracing::{error, info, warn};

// ─── Config structures (mirrors the SQLite schema) ────────────────────────────

#[derive(Debug, Clone)]
struct OsConn {
    id: i64,
    url: String,
    username: String,
    password: String,
    tls_verify: bool,
}

#[derive(Debug, Clone)]
struct ChCluster {
    id: i64,
    url: String,
    username: String,
    password: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FieldMapping {
    dest: String,
    source_type: String,  // field | static | full_doc | now | md5
    source_value: String,
}

#[derive(Debug, Clone)]
struct Pipeline {
    id: i64,
    name: String,
    os_conn: OsConn,
    index_pattern: String,
    pull_mode: String,
    pull_from_date: Option<String>,
    pull_to_date: Option<String>,
    ch_cluster: ChCluster,
    ch_database: String,
    ch_table: String,
    field_mappings: Vec<FieldMapping>,
    customer_source: String,
    customer_value: String,
    product_source: String,
    product_value: String,
    batch_mode: String,
    batch_size: usize,
    batch_timeout_ms: u64,
    dedup_enabled: bool,
    dedup_field: String,
    dedup_algo: String,
    poll_interval_secs: u64,
    retry_count: u32,
    pause_on_fail: bool,
}

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let db_path = std::env::var("DB_PATH")
        .unwrap_or_else(|_| "../backend/logbridge.db".to_string());
    let db_path = PathBuf::from(db_path);

    info!("LogBridge Shipper starting. DB: {:?}", db_path);

    // Max concurrent pipelines
    let sem = Arc::new(Semaphore::new(50));

    loop {
        let pipelines = match load_active_pipelines(&db_path) {
            Ok(p) => p,
            Err(e) => {
                error!("Failed to load pipelines: {:#}", e);
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
        };

        info!("Loaded {} active pipeline(s)", pipelines.len());

        let mut handles = vec![];
        for pipeline in pipelines {
            let sem = sem.clone();
            let db = db_path.clone();
            let h = tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                run_pipeline(pipeline, &db).await;
            });
            handles.push(h);
        }

        for h in handles {
            let _ = h.await;
        }

        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

// ─── Load pipelines from SQLite ───────────────────────────────────────────────

fn load_active_pipelines(db_path: &PathBuf) -> Result<Vec<Pipeline>> {
    let conn = Connection::open(db_path)?;

    let mut stmt = conn.prepare(r#"
        SELECT
            p.id, p.name,
            oc.id, oc.url, oc.username, oc.password, oc.tls_verify,
            p.index_pattern, p.pull_mode, p.pull_from_date, p.pull_to_date,
            cc.id, cc.url, cc.username, cc.password,
            p.clickhouse_database, p.clickhouse_table,
            p.field_mappings,
            p.customer_source, p.customer_value,
            p.product_source, p.product_value,
            p.batch_mode, p.batch_size, p.batch_timeout_ms,
            p.dedup_enabled, p.dedup_field, p.dedup_algo,
            p.poll_interval_secs, p.retry_count, p.pause_on_fail,
            COALESCE(ps.cursor_timestamp, ''), COALESCE(ps.cursor_id, ''),
            COALESCE(ps.last_run_at, '1970-01-01T00:00:00')
        FROM pipelines p
        JOIN opensearch_connections oc ON p.opensearch_connection_id = oc.id
        JOIN clickhouse_clusters cc ON p.clickhouse_cluster_id = cc.id
        LEFT JOIN pipeline_status ps ON p.id = ps.pipeline_id
        WHERE p.status = 'active'
    "#)?;

    let now = Utc::now().timestamp();

    let pipelines = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,    // id
            row.get::<_, String>(1)?, // name
            row.get::<_, i64>(2)?,    // os id
            row.get::<_, String>(3)?, // os url
            row.get::<_, String>(4)?, // os user
            row.get::<_, String>(5)?, // os pass
            row.get::<_, bool>(6)?,   // os tls_verify
            row.get::<_, String>(7)?, // index_pattern
            row.get::<_, String>(8)?, // pull_mode
            row.get::<_, Option<String>>(9)?,  // pull_from_date
            row.get::<_, Option<String>>(10)?, // pull_to_date
            row.get::<_, i64>(11)?,   // ch id
            row.get::<_, String>(12)?,// ch url
            row.get::<_, String>(13)?,// ch user
            row.get::<_, String>(14)?,// ch pass
            row.get::<_, String>(15)?,// ch db
            row.get::<_, String>(16)?,// ch table
            row.get::<_, String>(17)?,// field_mappings json
            row.get::<_, String>(18)?,// customer_source
            row.get::<_, String>(19)?,// customer_value
            row.get::<_, String>(20)?,// product_source
            row.get::<_, String>(21)?,// product_value
            row.get::<_, String>(22)?,// batch_mode
            row.get::<_, i64>(23)?,   // batch_size
            row.get::<_, i64>(24)?,   // batch_timeout_ms
            row.get::<_, bool>(25)?,  // dedup_enabled
            row.get::<_, String>(26)?,// dedup_field
            row.get::<_, String>(27)?,// dedup_algo
            row.get::<_, i64>(28)?,   // poll_interval_secs
            row.get::<_, i64>(29)?,   // retry_count
            row.get::<_, bool>(30)?,  // pause_on_fail
            row.get::<_, String>(31)?,// cursor_timestamp
            row.get::<_, String>(32)?,// cursor_id
            row.get::<_, String>(33)?,// last_run_at
        ))
    })?
    .filter_map(|r| r.ok())
    .filter(|r| {
        // Respect poll interval: only run if enough time has passed since last run
        let last_run = chrono::DateTime::parse_from_rfc3339(&r.33)
            .map(|d| d.timestamp())
            .unwrap_or(0);
        now - last_run >= r.28
    })
    .map(|r| {
        let mappings: Vec<FieldMapping> = serde_json::from_str(&r.17).unwrap_or_default();
        Pipeline {
            id: r.0,
            name: r.1,
            os_conn: OsConn { id: r.2, url: r.3, username: r.4, password: r.5, tls_verify: r.6 },
            index_pattern: r.7,
            pull_mode: r.8,
            pull_from_date: r.9,
            pull_to_date: r.10,
            ch_cluster: ChCluster { id: r.11, url: r.12, username: r.13, password: r.14 },
            ch_database: r.15,
            ch_table: r.16,
            field_mappings: mappings,
            customer_source: r.18,
            customer_value: r.19,
            product_source: r.20,
            product_value: r.21,
            batch_mode: r.22,
            batch_size: r.23 as usize,
            batch_timeout_ms: r.24 as u64,
            dedup_enabled: r.25,
            dedup_field: r.26,
            dedup_algo: r.27,
            poll_interval_secs: r.28 as u64,
            retry_count: r.29 as u32,
            pause_on_fail: r.30,
        }
    })
    .collect();

    Ok(pipelines)
}

// ─── Run a single pipeline ────────────────────────────────────────────────────

async fn run_pipeline(pipeline: Pipeline, db_path: &PathBuf) {
    info!("[{}] Starting run", pipeline.name);

    let http = match build_client(&pipeline.os_conn) {
        Ok(c) => c,
        Err(e) => { error!("[{}] HTTP client error: {:#}", pipeline.name, e); return; }
    };

    // Load cursor
    let (mut cursor_ts, mut cursor_id) = load_cursor(db_path, pipeline.id);

    let mut total_inserted = 0usize;
    let mut total_skipped = 0usize;
    let start = Instant::now();

    loop {
        let result = fetch_page(
            &http,
            &pipeline.os_conn.url,
            &pipeline.os_conn.username,
            &pipeline.os_conn.password,
            &pipeline.index_pattern,
            pipeline.batch_size,
            cursor_ts.as_deref(),
            cursor_id.as_deref(),
        ).await;

        let (docs, next) = match result {
            Ok(r) => r,
            Err(e) => {
                error!("[{}] Fetch error: {:#}", pipeline.name, e);
                write_error(db_path, pipeline.id, &e.to_string());
                if pipeline.pause_on_fail {
                    pause_pipeline(db_path, pipeline.id);
                }
                break;
            }
        };

        if docs.is_empty() {
            info!("[{}] Caught up. {} inserted, {} skipped in {:.1}s",
                pipeline.name, total_inserted, total_skipped, start.elapsed().as_secs_f32());
            break;
        }

        // Transform + dedup
        let mut rows = vec![];
        for doc in &docs {
            let row = transform_doc(doc, &pipeline);
            if pipeline.dedup_enabled {
                // Check dedup via event_id field
                if let Some(Value::String(eid)) = row.get("event_id") {
                    if is_duplicate(&http, &pipeline, eid).await {
                        total_skipped += 1;
                        continue;
                    }
                }
            }
            rows.push(row);
        }

        if !rows.is_empty() {
            let ndjson = rows.iter()
                .map(|r| serde_json::to_string(r).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n");

            match insert_rows(&http, &pipeline, &ndjson).await {
                Ok(_) => {
                    total_inserted += rows.len();
                    info!("[{}] Inserted {} rows", pipeline.name, rows.len());
                }
                Err(e) => {
                    error!("[{}] Insert error: {:#}", pipeline.name, e);
                    write_error(db_path, pipeline.id, &e.to_string());
                    if pipeline.pause_on_fail {
                        pause_pipeline(db_path, pipeline.id);
                    }
                    break;
                }
            }
        }

        // Advance cursor
        if let Some((ts, id)) = next {
            cursor_ts = Some(ts.clone());
            cursor_id = Some(id.clone());
            save_cursor(db_path, pipeline.id, &ts, &id, total_inserted, total_skipped);
        } else {
            break;
        }

        // Respect batch timeout
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    write_success(db_path, pipeline.id, total_inserted, total_skipped);
}

// ─── Transform a doc per field mappings ──────────────────────────────────────

fn transform_doc(doc: &Value, pipeline: &Pipeline) -> Value {
    let mut row = serde_json::Map::new();

    for m in &pipeline.field_mappings {
        let val = match m.source_type.as_str() {
            "field" => get_nested(doc, &m.source_value),
            "static" => Value::String(m.source_value.clone()),
            "full_doc" => Value::String(doc.to_string()),
            "now" => Value::String(Utc::now().to_rfc3339()),
            "md5" => {
                let field_val = get_nested(doc, &m.source_value).to_string();
                Value::String(hash_md5(&field_val))
            }
            _ => Value::Null,
        };
        row.insert(m.dest.clone(), val);
    }

    // Inject customer + product if not already in mappings
    if !row.contains_key("customer") {
        let val = if pipeline.customer_source == "field" {
            get_nested(doc, &pipeline.customer_value).as_str().unwrap_or(&pipeline.customer_value).to_string()
        } else {
            pipeline.customer_value.clone()
        };
        row.insert("customer".to_string(), Value::String(val));
    }

    if !row.contains_key("product") {
        let val = if pipeline.product_source == "field" {
            get_nested(doc, &pipeline.product_value).as_str().unwrap_or(&pipeline.product_value).to_string()
        } else {
            pipeline.product_value.clone()
        };
        row.insert("product".to_string(), Value::String(val));
    }

    // Compute event_id for dedup
    if pipeline.dedup_enabled {
        let raw = get_nested(doc, &pipeline.dedup_field).to_string();
        let hash = if pipeline.dedup_algo == "sha256" { hash_sha256(&raw) } else { hash_md5(&raw) };
        row.insert("event_id".to_string(), Value::String(hash));
    }

    Value::Object(row)
}

fn get_nested(doc: &Value, path: &str) -> Value {
    let mut cur = doc;
    for key in path.split('.') {
        cur = &cur[key];
    }
    cur.clone()
}

fn hash_md5(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn hash_sha256(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

// ─── OpenSearch helpers ───────────────────────────────────────────────────────

fn build_client(conn: &OsConn) -> Result<Client> {
    let builder = Client::builder().timeout(Duration::from_secs(60));
    let builder = if !conn.tls_verify {
        builder.danger_accept_invalid_certs(true)
    } else {
        builder
    };
    Ok(builder.build()?)
}

fn basic_auth(username: &str, password: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let encoded = STANDARD.encode(format!("{}:{}", username, password));
    format!("Basic {}", encoded)
}

async fn fetch_page(
    client: &Client,
    base_url: &str,
    username: &str,
    password: &str,
    index: &str,
    batch_size: usize,
    cursor_ts: Option<&str>,
    cursor_id: Option<&str>,
) -> Result<(Vec<Value>, Option<(String, String)>)> {
    let mut query = json!({
        "size": batch_size,
        "sort": [{ "@timestamp": "asc" }, { "_id": "asc" }],
        "query": { "match_all": {} }
    });

    if let (Some(ts), Some(id)) = (cursor_ts, cursor_id) {
        if !ts.is_empty() {
            query["query"] = json!({ "bool": { "filter": [{ "range": { "@timestamp": { "gt": ts } } }] } });
            query["search_after"] = json!([ts, id]);
        }
    }

    let url = format!("{}/{}/_search", base_url, index);
    let res = client.post(&url)
        .header("Authorization", basic_auth(username, password))
        .json(&query)
        .send().await.context("OpenSearch request failed")?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        anyhow::bail!("OpenSearch error: {}", text);
    }

    let body: Value = res.json().await?;
    let hits = body["hits"]["hits"].as_array().cloned().unwrap_or_default();

    if hits.is_empty() { return Ok((vec![], None)); }

    let last = &hits[hits.len() - 1];
    let next_ts = last["_source"]["@timestamp"].as_str().unwrap_or("").to_string();
    let next_id = last["_id"].as_str().unwrap_or("").to_string();

    let docs: Vec<Value> = hits.into_iter().map(|h| h["_source"].clone()).collect();
    Ok((docs, Some((next_ts, next_id))))
}

// ─── ClickHouse helpers ───────────────────────────────────────────────────────

async fn insert_rows(client: &Client, pipeline: &Pipeline, ndjson: &str) -> Result<()> {
    let sql = format!("INSERT INTO `{}`.`{}` FORMAT JSONEachRow", pipeline.ch_database, pipeline.ch_table);
    let url = format!("{}/?query={}&input_format_skip_unknown_fields=1",
        pipeline.ch_cluster.url, urlencoding::encode(&sql));

    let res = client.post(&url)
        .header("Authorization", basic_auth(&pipeline.ch_cluster.username, &pipeline.ch_cluster.password))
        .header("Content-Type", "application/x-ndjson")
        .body(ndjson.to_string())
        .send().await.context("ClickHouse insert request failed")?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        anyhow::bail!("ClickHouse insert error: {}", text);
    }
    Ok(())
}

async fn is_duplicate(client: &Client, pipeline: &Pipeline, event_id: &str) -> bool {
    let sql = format!("SELECT 1 FROM `{}`.`{}` WHERE event_id = '{}' LIMIT 1",
        pipeline.ch_database, pipeline.ch_table, event_id.replace('\'', "''"));
    let url = format!("{}/?query={}", pipeline.ch_cluster.url, urlencoding::encode(&sql));
    let res = client.get(&url)
        .header("Authorization", basic_auth(&pipeline.ch_cluster.username, &pipeline.ch_cluster.password))
        .send().await;
    match res {
        Ok(r) => {
            let text = r.text().await.unwrap_or_default();
            !text.trim().is_empty() && text.trim() != "0"
        }
        Err(_) => false,
    }
}

// ─── SQLite helpers ───────────────────────────────────────────────────────────

fn load_cursor(db_path: &PathBuf, pipeline_id: i64) -> (Option<String>, Option<String>) {
    let conn = Connection::open(db_path).ok();
    if let Some(c) = conn {
        let row = c.query_row(
            "SELECT cursor_timestamp, cursor_id FROM pipeline_status WHERE pipeline_id = ?1",
            params![pipeline_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        ).ok();
        if let Some((ts, id)) = row {
            return (ts, id);
        }
    }
    (None, None)
}

fn save_cursor(db_path: &PathBuf, pipeline_id: i64, ts: &str, id: &str, inserted: usize, skipped: usize) {
    if let Ok(c) = Connection::open(db_path) {
        let now = Utc::now().to_rfc3339();
        let _ = c.execute(
            r#"INSERT INTO pipeline_status (pipeline_id, cursor_timestamp, cursor_id, last_run_at, updated_at)
               VALUES (?1,?2,?3,?4,?4)
               ON CONFLICT(pipeline_id) DO UPDATE SET
                 cursor_timestamp=excluded.cursor_timestamp,
                 cursor_id=excluded.cursor_id,
                 last_run_at=excluded.last_run_at,
                 rows_inserted_total = rows_inserted_total + ?5,
                 rows_skipped_dedup = rows_skipped_dedup + ?6,
                 updated_at=excluded.updated_at"#,
            params![pipeline_id, ts, id, now, inserted as i64, skipped as i64],
        );
    }
}

fn write_error(db_path: &PathBuf, pipeline_id: i64, err: &str) {
    if let Ok(c) = Connection::open(db_path) {
        let now = Utc::now().to_rfc3339();
        let _ = c.execute(
            "UPDATE pipeline_status SET status='error', last_error=?1, updated_at=?2 WHERE pipeline_id=?3",
            params![err, now, pipeline_id],
        );
        let _ = c.execute(
            "INSERT INTO pipeline_logs (pipeline_id, level, message) VALUES (?1, 'error', ?2)",
            params![pipeline_id, err],
        );
    }
}

fn write_success(db_path: &PathBuf, pipeline_id: i64, inserted: usize, skipped: usize) {
    if let Ok(c) = Connection::open(db_path) {
        let now = Utc::now().to_rfc3339();
        let _ = c.execute(
            r#"UPDATE pipeline_status SET
                 status='idle', last_success_at=?1, last_error=NULL,
                 rows_inserted_today = rows_inserted_today + ?2,
                 rows_inserted_total = rows_inserted_total + ?2,
                 rows_skipped_dedup = rows_skipped_dedup + ?3,
                 updated_at=?1
               WHERE pipeline_id=?4"#,
            params![now, inserted as i64, skipped as i64, pipeline_id],
        );
    }
}

fn pause_pipeline(db_path: &PathBuf, pipeline_id: i64) {
    if let Ok(c) = Connection::open(db_path) {
        let _ = c.execute(
            "UPDATE pipelines SET status='paused' WHERE id=?1",
            params![pipeline_id],
        );
        warn!("Pipeline {} paused due to repeated failures", pipeline_id);
    }
}
