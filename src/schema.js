// Same SQL runs on node:sqlite and Cloudflare D1.
// Only CREATE IF NOT EXISTS for now. When a column has to change we'll need real migrations.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    schedule_type TEXT NOT NULL,
    schedule_value TEXT NOT NULL,
    schedule_timezone TEXT,
    status TEXT NOT NULL,
    pause_reason TEXT,
    next_run_at TEXT,
    current_run_id TEXT,
    last_run_id TEXT,
    webhook_url TEXT,
    webhook_events TEXT,
    webhook_secret TEXT,
    webhook_old_secret TEXT,
    webhook_old_secret_until TEXT,
    window_to TEXT,
    fail_streak INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    idem_key TEXT UNIQUE,
    idem_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS monitor_targets (
    monitor_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    query TEXT,
    max_results INTEGER,
    freshness TEXT,
    url TEXT,
    judge_threshold REAL,
    PRIMARY KEY (monitor_id, position)
  )`,

  `CREATE TABLE IF NOT EXISTS monitor_domains (
    monitor_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    domain TEXT NOT NULL,
    PRIMARY KEY (monitor_id, kind, domain)
  )`,

  `CREATE TABLE IF NOT EXISTS monitor_metadata (
    monitor_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (monitor_id, key)
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    window_from TEXT,
    window_to TEXT,
    candidates INTEGER NOT NULL DEFAULT 0,
    change_count INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    fetched_urls INTEGER NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    error_code TEXT,
    skip_reason TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS runs_by_monitor ON runs (monitor_id, id)`,

  `CREATE TABLE IF NOT EXISTS run_changes (
    run_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    snippet TEXT,
    confidence REAL NOT NULL,
    published_at TEXT,
    last_updated_at TEXT,
    diff_unified TEXT,
    diff_added INTEGER,
    diff_removed INTEGER,
    diff_truncated INTEGER,
    previous_fetched_at TEXT,
    fetched_at TEXT,
    PRIMARY KEY (run_id, position)
  )`,

  `CREATE TABLE IF NOT EXISTS run_target_errors (
    run_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    url TEXT NOT NULL,
    code TEXT NOT NULL,
    status_code INTEGER,
    message TEXT NOT NULL,
    PRIMARY KEY (run_id, position)
  )`,

  `CREATE TABLE IF NOT EXISTS seen_urls (
    monitor_id TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (monitor_id, url)
  )`,

  `CREATE TABLE IF NOT EXISTS page_baselines (
    monitor_id TEXT NOT NULL,
    url TEXT NOT NULL,
    text TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (monitor_id, url)
  )`,

  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL,
    body TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    next_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    failures INTEGER NOT NULL,
    locked_until TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (username, ip)
  )`,
]
