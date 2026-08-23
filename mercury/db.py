"""SQLite storage."""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config import Config

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    work_date    TEXT NOT NULL,
    address      TEXT NOT NULL DEFAULT '',
    order_number TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    items        TEXT NOT NULL DEFAULT '{}',
    total        REAL NOT NULL DEFAULT 0,
    needs_buried INTEGER NOT NULL DEFAULT 0,
    needs_bore   INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'complete',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0,
    device_id    TEXT NOT NULL DEFAULT '',
    seq          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_seq  ON jobs(seq);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(work_date);

CREATE TABLE IF NOT EXISTS custom_items (
    id          TEXT PRIMARY KEY,
    work_date   TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    qty         REAL NOT NULL DEFAULT 1,
    rate        REAL NOT NULL DEFAULT 0,
    total       REAL NOT NULL DEFAULT 0,
    bill_to     TEXT NOT NULL DEFAULT 'mercury',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    device_id   TEXT NOT NULL DEFAULT '',
    seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_custom_seq  ON custom_items(seq);
CREATE INDEX IF NOT EXISTS idx_custom_date ON custom_items(work_date);

CREATE TABLE IF NOT EXISTS equipment_scans (
    id         TEXT PRIMARY KEY,
    job_id     TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    payload    TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'offline',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT NOT NULL DEFAULT '',
    seq        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scans_seq ON equipment_scans(seq);

CREATE TABLE IF NOT EXISTS invoices (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    number       TEXT NOT NULL,
    period_start TEXT NOT NULL DEFAULT '',
    period_end   TEXT NOT NULL DEFAULT '',
    due_date     TEXT NOT NULL DEFAULT '',
    total        REAL NOT NULL DEFAULT 0,
    filename     TEXT NOT NULL DEFAULT '',
    emailed_at   TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_devices (
    device_id  TEXT PRIMARY KEY,
    label      TEXT NOT NULL DEFAULT '',
    last_seen  TEXT NOT NULL,
    last_seq   INTEGER NOT NULL DEFAULT 0,
    pushes     INTEGER NOT NULL DEFAULT 0
);
"""

SYNC_TABLES = {
    "jobs": [
        "id", "work_date", "address", "order_number", "notes", "items",
        "total", "needs_buried", "needs_bore", "status", "created_at",
        "updated_at", "deleted", "device_id",
    ],
    "custom_items": [
        "id", "work_date", "name", "description", "qty", "rate", "total",
        "bill_to", "created_at", "updated_at", "deleted", "device_id",
    ],
    "equipment_scans": [
        "id", "job_id", "address", "payload", "source",
        "created_at", "updated_at", "deleted", "device_id",
    ],
}

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def new_id() -> str:
    return str(uuid.uuid4())

def get_db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        Config.ensure_dirs()
        conn = sqlite3.connect(Config.DB_PATH, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        _local.conn = conn
    return conn

def close_db(_exc=None) -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None

def init_db() -> None:
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('seq_counter', '0')")
    
    # Check if needs_buried column exists (for upgrading old database)
    columns = [col[1] for col in conn.execute("PRAGMA table_info(jobs)").fetchall()]
    if "needs_buried" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN needs_buried INTEGER NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE jobs ADD COLUMN needs_bore INTEGER NOT NULL DEFAULT 0")
        
    conn.commit()

def next_seq(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key = 'seq_counter'").fetchone()
    value = int(row["value"]) + 1
    conn.execute("UPDATE meta SET value = ? WHERE key = 'seq_counter'", (str(value),))
    return value

def current_seq() -> int:
    row = get_db().execute("SELECT value FROM meta WHERE key = 'seq_counter'").fetchone()
    return int(row["value"]) if row else 0

def row_to_dict(row: sqlite3.Row) -> dict:
    data = dict(row)
    if "items" in data and isinstance(data["items"], str):
        try:
            data["items"] = json.loads(data["items"])
        except (ValueError, TypeError):
            data["items"] = {}
    return data

def backup_to(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    dest = sqlite3.connect(path)
    with dest:
        get_db().backup(dest)
    dest.close()
    return path
