"""Bidirectional delta sync between field devices and the server.

The contract is intentionally small:

  POST /api/sync   {device_id, since, changes: {jobs: [...], custom_items: [...], ...}}
    -> {server_seq, applied, conflicts, changes: {...rows with seq > since...}}

Push and pull happen in one round trip, so a phone coming back into signal
settles up in a single request. Writes are idempotent on the row's UUID and
resolve last-write-wins by ``updated_at``, which makes retrying a request
that timed out mid-flight harmless.
"""
from __future__ import annotations

from .db import SYNC_TABLES, current_seq, get_db, next_seq, row_to_dict, utcnow
from .models import save_custom_item, save_job, save_scan

# Which saver handles each syncable table.
_SAVERS = {
    "jobs": save_job,
    "custom_items": save_custom_item,
    "equipment_scans": save_scan,
}

MAX_ROWS_PER_PUSH = 2000


def apply_changes(changes: dict, device_id: str = "") -> dict:
    """Apply a device's queued writes. Returns per-table results."""
    applied: dict[str, int] = {}
    rejected: list[dict] = []
    ids: dict[str, list[str]] = {}

    for table, saver in _SAVERS.items():
        rows = changes.get(table) or []
        if not isinstance(rows, list):
            continue
        applied[table] = 0
        ids[table] = []
        for row in rows[:MAX_ROWS_PER_PUSH]:
            if not isinstance(row, dict):
                continue
            try:
                saved = saver(row, device_id=device_id)
            except Exception as exc:  # one bad row must not sink the batch
                rejected.append({
                    "table": table,
                    "id": row.get("id"),
                    "error": str(exc),
                })
                continue
            applied[table] += 1
            if saved and saved.get("id"):
                ids[table].append(saved["id"])

    return {"applied": applied, "rejected": rejected, "ids": ids}


def pull_changes(since: int, exclude_device: str = "") -> dict:
    """Every syncable row written after sequence ``since``.

    Rows the requesting device itself wrote are still returned; the client
    reconciles by ID, and echoing them back is how a device confirms the
    server accepted its push.
    """
    conn = get_db()
    out: dict[str, list[dict]] = {}
    for table, columns in SYNC_TABLES.items():
        cols = ", ".join(columns) + ", seq"
        rows = conn.execute(
            f"SELECT {cols} FROM {table} WHERE seq > ? ORDER BY seq ASC LIMIT 5000",
            (since,),
        ).fetchall()
        out[table] = [row_to_dict(r) for r in rows]
    return out


def touch_device(device_id: str, label: str = "", seq: int = 0) -> None:
    if not device_id:
        return
    conn = get_db()
    with conn:
        conn.execute(
            """
            INSERT INTO sync_devices (device_id, label, last_seen, last_seq, pushes)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(device_id) DO UPDATE SET
                last_seen = excluded.last_seen,
                last_seq  = MAX(sync_devices.last_seq, excluded.last_seq),
                label     = CASE WHEN excluded.label != '' THEN excluded.label ELSE sync_devices.label END,
                pushes    = sync_devices.pushes + 1
            """,
            (device_id, label, utcnow(), seq),
        )


def sync(payload: dict) -> dict:
    """Handle one full push/pull round trip."""
    device_id = (payload.get("device_id") or "").strip()
    try:
        since = int(payload.get("since") or 0)
    except (TypeError, ValueError):
        since = 0

    result = apply_changes(payload.get("changes") or {}, device_id=device_id)
    server_seq = current_seq()
    touch_device(device_id, payload.get("device_label", ""), server_seq)

    return {
        "ok": True,
        "server_seq": server_seq,
        "server_time": utcnow(),
        "applied": result["applied"],
        "rejected": result["rejected"],
        "acknowledged": result["ids"],
        "changes": pull_changes(since, exclude_device=device_id),
    }


def devices() -> list[dict]:
    rows = get_db().execute(
        "SELECT * FROM sync_devices ORDER BY last_seen DESC").fetchall()
    return [dict(r) for r in rows]
