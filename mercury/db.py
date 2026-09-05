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
    -- When this job was included in a dispatch report (manual or the 8pm
    -- send). NULL means it still needs reporting. Server-side bookkeeping
    -- only: deliberately absent from SYNC_TABLES and from save_job()'s
    -- upsert, so a phone re-pushing an edited job can never clear it and
    -- cause the same address to be dispatched twice.
    dispatched_at TEXT,
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

CREATE TABLE IF NOT EXISTS rates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    rate       REAL NOT NULL DEFAULT 0,
    unit       TEXT NOT NULL DEFAULT 'ea',
    is_tiered  INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);
"""

# Seeded into `rates` the first time the table is empty. Kept in step with
# rates.py's hardcoded fallback list, which these rows now supersede.
DEFAULT_RATE_CARD = [
    ("Installation", 110.00, "ea", 0, 1),
    ("Fusion Splice", 15.00, "ea", 0, 2),
    ("Place Nid w/ Riser", 12.50, "ea", 0, 3),
    ("Temp drop laid", 20.00, "ea", 0, 4),
    ("Trip Fee", 30.00, "ea", 0, 5),
    ("Direct bury flat drop (0-300')", 75.00, "ea", 0, 6),
    ("bore (0-12')", 25.00, "ea", 0, 7),
    ("Conduit Pull Footage", 0.55, "ft", 0, 8),
    # Tiered, so its flat "rate" is a placeholder — aerial_drop_price() in
    # rates.py prices it, never this column.
    ("Aerial Drop Footage", 0.00, "ft", 1, 9),
]

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

    # Existing databases predate per-job dispatch tracking. Adding it NULL
    # means every job already on disk reads as "not yet dispatched", which
    # is the safe direction: at worst an address gets reported once more.
    if "dispatched_at" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN dispatched_at TEXT")

    # Seed the rate card once. Without this the `rates` table exists but is
    # empty, so every lookup falls through to rates.py's hardcoded list and
    # the rate-editor UI has nothing real to edit.
    if conn.execute("SELECT COUNT(*) AS n FROM rates").fetchone()["n"] == 0:
        conn.executemany(
            "INSERT INTO rates (id, name, rate, unit, is_tiered, sort_order) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [(new_id(), name, rate, unit, tiered, order)
             for name, rate, unit, tiered, order in DEFAULT_RATE_CARD],
        )

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
