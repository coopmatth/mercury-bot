"""Repository layer: week math, CRUD and the aggregates the dashboard needs."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from .config import Config
from .db import get_db, new_id, next_seq, row_to_dict, utcnow
from .rates import (AERIAL_ITEM, ITEM_LIST, PAY_RATES, aerial_tier,
                    calculate_job_total, item_price)

DATE_FMT = "%Y-%m-%d"

def week_start(for_date: date | None = None) -> date:
    d = for_date or date.today()
    offset = (d.weekday() - Config.WEEK_START_WEEKDAY) % 7
    return d - timedelta(days=offset)

def week_bounds(for_date: date | None = None) -> tuple[date, date]:
    start = week_start(for_date)
    return start, start + timedelta(days=6)

def last_completed_week(for_date: date | None = None) -> tuple[date, date]:
    start = week_start(for_date) - timedelta(days=7)
    return start, start + timedelta(days=6)

def week_label(start: date, end: date) -> str:
    return f"{start.strftime('%m-%d-%y')}_to_{end.strftime('%m-%d-%y')}"

def parse_date(value: str | None, fallback: date | None = None) -> date:
    if not value:
        return fallback or date.today()
    for fmt in (DATE_FMT, "%m/%d/%Y", "%m-%d-%y"):
        try:
            return datetime.strptime(value[:10], fmt).date()
        except ValueError:
            continue
    return fallback or date.today()

def recent_weeks(limit: int = 12) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT work_date FROM jobs WHERE deleted = 0 "
        "UNION SELECT work_date FROM custom_items WHERE deleted = 0"
    ).fetchall()
    starts = {week_start(parse_date(r["work_date"])) for r in rows}
    starts.add(week_start())
    starts.add(last_completed_week()[0])
    ordered = sorted(starts, reverse=True)[:limit]
    return [
        {
            "start": s.strftime(DATE_FMT),
            "end": (s + timedelta(days=6)).strftime(DATE_FMT),
            "label": f"{s.strftime('%b %d')} – {(s + timedelta(days=6)).strftime('%b %d, %Y')}",
            "is_current": s == week_start(),
        }
        for s in ordered
    ]

def normalize_items(raw: dict | None) -> dict:
    items = {}
    for name, qty in (raw or {}).items():
        if name not in ITEM_LIST:
            continue
        try:
            value = float(qty)
        except (TypeError, ValueError):
            continue
        if value > 0:
            items[name] = value
    return items

def save_job(payload: dict, device_id: str = "") -> dict:
    conn = get_db()
    job_id = (payload.get("id") or "").strip() or new_id()
    items = normalize_items(payload.get("items"))
    total = calculate_job_total(items)
    now = utcnow()
    updated_at = payload.get("updated_at") or now
    needs_buried = 1 if payload.get("needs_buried") in (1, True, "1", "true") else 0
    needs_bore = 1 if payload.get("needs_bore") in (1, True, "1", "true") else 0

    with conn:
        existing = conn.execute(
            "SELECT updated_at FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if existing and existing["updated_at"] > updated_at:
            return get_job(job_id)

        seq = next_seq(conn)
        conn.execute(
            """
            INSERT INTO jobs (id, work_date, address, order_number, notes, items,
                              total, needs_buried, needs_bore, status, created_at, updated_at, deleted, device_id, seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                work_date=excluded.work_date, address=excluded.address,
                order_number=excluded.order_number, notes=excluded.notes,
                items=excluded.items, total=excluded.total,
                needs_buried=excluded.needs_buried, needs_bore=excluded.needs_bore,
                status=excluded.status, updated_at=excluded.updated_at,
                deleted=excluded.deleted, device_id=excluded.device_id, seq=excluded.seq
            """,
            (
                job_id,
                parse_date(payload.get("work_date")).strftime(DATE_FMT),
                (payload.get("address") or "").strip(),
                (payload.get("order_number") or "").strip(),
                (payload.get("notes") or "").strip(),
                json.dumps(items),
                total,
                needs_buried,
                needs_bore,
                payload.get("status") or "complete",
                payload.get("created_at") or now,
                updated_at,
                1 if payload.get("deleted") else 0,
                payload.get("device_id") or device_id,
                seq,
            ),
        )
    return get_job(job_id)

def get_job(job_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return row_to_dict(row) if row else None

def list_jobs(start: date | None = None, end: date | None = None,
              search: str = "", limit: int = 500) -> list[dict]:
    sql = "SELECT * FROM jobs WHERE deleted = 0"
    args: list = []
    if start:
        sql += " AND work_date >= ?"
        args.append(start.strftime(DATE_FMT))
    if end:
        sql += " AND work_date <= ?"
        args.append(end.strftime(DATE_FMT))
    if search:
        sql += " AND (address LIKE ? OR order_number LIKE ? OR notes LIKE ?)"
        term = f"%{search}%"
        args += [term, term, term]
    sql += " ORDER BY work_date DESC, created_at DESC LIMIT ?"
    args.append(limit)
    return [row_to_dict(r) for r in get_db().execute(sql, args).fetchall()]

def delete_job(job_id: str, device_id: str = "") -> bool:
    conn = get_db()
    with conn:
        seq = next_seq(conn)
        cur = conn.execute(
            "UPDATE jobs SET deleted = 1, updated_at = ?, seq = ?, device_id = ? WHERE id = ?",
            (utcnow(), seq, device_id, job_id),
        )
    return cur.rowcount > 0

def save_custom_item(payload: dict, device_id: str = "") -> dict | None:
    conn = get_db()
    item_id = (payload.get("id") or "").strip() or new_id()
    try:
        qty = float(payload.get("qty") or 0)
        rate = float(payload.get("rate") or 0)
    except (TypeError, ValueError):
        qty, rate = 0.0, 0.0
    now = utcnow()
    updated_at = payload.get("updated_at") or now

    with conn:
        existing = conn.execute(
            "SELECT updated_at FROM custom_items WHERE id = ?", (item_id,)).fetchone()
        if existing and existing["updated_at"] > updated_at:
            return get_custom_item(item_id)

        seq = next_seq(conn)
        conn.execute(
            """
            INSERT INTO custom_items (id, work_date, name, description, qty, rate, total,
                                      bill_to, created_at, updated_at, deleted, device_id, seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                work_date=excluded.work_date, name=excluded.name,
                description=excluded.description, qty=excluded.qty, rate=excluded.rate,
                total=excluded.total, bill_to=excluded.bill_to,
                updated_at=excluded.updated_at, deleted=excluded.deleted,
                device_id=excluded.device_id, seq=excluded.seq
            """,
            (
                item_id,
                parse_date(payload.get("work_date")).strftime(DATE_FMT),
                (payload.get("name") or "").strip(),
                (payload.get("description") or payload.get("desc") or "").strip(),
                qty, rate, round(qty * rate, 2),
                payload.get("bill_to") if payload.get("bill_to") in ("mercury", "remc") else "mercury",
                payload.get("created_at") or now,
                updated_at,
                1 if payload.get("deleted") else 0,
                payload.get("device_id") or device_id,
                seq,
            ),
        )
    return get_custom_item(item_id)

def get_custom_item(item_id: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM custom_items WHERE id = ?", (item_id,)).fetchone()
    return row_to_dict(row) if row else None

def list_custom_items(start: date | None = None, end: date | None = None,
                      bill_to: str | None = None) -> list[dict]:
    sql = "SELECT * FROM custom_items WHERE deleted = 0"
    args: list = []
    if start:
        sql += " AND work_date >= ?"
        args.append(start.strftime(DATE_FMT))
    if end:
        sql += " AND work_date <= ?"
        args.append(end.strftime(DATE_FMT))
    if bill_to:
        sql += " AND bill_to = ?"
        args.append(bill_to)
    sql += " ORDER BY work_date DESC, created_at DESC"
    return [row_to_dict(r) for r in get_db().execute(sql, args).fetchall()]

def delete_custom_item(item_id: str, device_id: str = "") -> bool:
    conn = get_db()
    with conn:
        seq = next_seq(conn)
        cur = conn.execute(
            "UPDATE custom_items SET deleted = 1, updated_at = ?, seq = ?, device_id = ? WHERE id = ?",
            (utcnow(), seq, device_id, item_id),
        )
    return cur.rowcount > 0

def save_scan(payload: dict, device_id: str = "") -> dict:
    conn = get_db()
    scan_id = (payload.get("id") or "").strip() or new_id()
    now = utcnow()
    with conn:
        seq = next_seq(conn)
        conn.execute(
            """
            INSERT INTO equipment_scans (id, job_id, address, payload, source,
                                         created_at, updated_at, deleted, device_id, seq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                job_id=excluded.job_id, address=excluded.address,
                payload=excluded.payload, source=excluded.source,
                updated_at=excluded.updated_at, deleted=excluded.deleted, seq=excluded.seq
            """,
            (
                scan_id,
                payload.get("job_id") or "",
                (payload.get("address") or "").strip(),
                payload.get("payload") or "",
                payload.get("source") or "offline",
                payload.get("created_at") or now,
                payload.get("updated_at") or now,
                1 if payload.get("deleted") else 0,
                payload.get("device_id") or device_id,
                seq,
            ),
        )
    row = conn.execute(
        "SELECT * FROM equipment_scans WHERE id = ?", (scan_id,)).fetchone()
    return row_to_dict(row)

def list_scans(limit: int = 100) -> list[dict]:
    rows = get_db().execute(
        "SELECT * FROM equipment_scans WHERE deleted = 0 "
        "ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [row_to_dict(r) for r in rows]

def delete_scan(scan_id: str, device_id: str = "") -> bool:
    conn = get_db()
    with conn:
        seq = next_seq(conn)
        cur = conn.execute(
            "UPDATE equipment_scans SET deleted = 1, updated_at = ?, seq = ?, device_id = ? WHERE id = ?",
            (utcnow(), seq, device_id, scan_id),
        )
    return cur.rowcount > 0

def week_summary(start: date, end: date) -> dict:
    jobs = list_jobs(start, end)
    customs = list_custom_items(start, end)
    today_str = date.today().strftime(DATE_FMT)

    task_counts: dict[str, float] = {}
    task_pay: dict[str, float] = {}
    per_day: dict[str, float] = {
        (start + timedelta(days=i)).strftime(DATE_FMT): 0.0 for i in range(7)
    }

    for job in jobs:
        for name, qty in job["items"].items():
            task_counts[name] = task_counts.get(name, 0) + qty
            task_pay[name] = round(task_pay.get(name, 0.0) + item_price(name, qty), 2)
        if job["work_date"] in per_day:
            per_day[job["work_date"]] += job["total"]

    for item in customs:
        if item["work_date"] in per_day:
            per_day[item["work_date"]] += item["total"]

    jobs_total = round(sum(j["total"] for j in jobs), 2)
    custom_total = round(sum(c["total"] for c in customs), 2)
    weekly = round(jobs_total + custom_total, 2)
    daily = round(
        sum(j["total"] for j in jobs if j["work_date"] == today_str)
        + sum(c["total"] for c in customs if c["work_date"] == today_str),
        2,
    )
    days_worked = len([v for v in per_day.values() if v > 0])

    return {
        "start": start.strftime(DATE_FMT),
        "end": end.strftime(DATE_FMT),
        "range_label": f"{start.strftime('%b %d')} – {end.strftime('%b %d, %Y')}",
        "daily": daily,
        "weekly": weekly,
        "jobs_total": jobs_total,
        "custom_total": custom_total,
        "job_count": len(jobs),
        "custom_count": len(customs),
        "days_worked": days_worked,
        "avg_per_job": round(jobs_total / len(jobs), 2) if jobs else 0.0,
        "avg_per_day": round(weekly / days_worked, 2) if days_worked else 0.0,
        "task_counts": task_counts,
        "task_pay": task_pay,
        "per_day": [
            {
                "date": d,
                "label": datetime.strptime(d, DATE_FMT).strftime("%a"),
                "amount": round(v, 2),
            }
            for d, v in per_day.items()
        ],
        "jobs": jobs,
        "customs": customs,
    }

def invoice_lines(start: date, end: date, extra_items: list[dict] | None = None) -> tuple[list[dict], float]:
    from .rates import (AERIAL_TIER_1_PRICE, AERIAL_TIER_2_PRICE,
                        aerial_drop_price)

    counts: dict[str, float] = {}
    aerial: dict[str, list[float]] = {"0-300": [], "301-600": [], "601+": []}

    for job in list_jobs(start, end):
        for name, qty in job["items"].items():
            if name == AERIAL_ITEM:
                aerial[aerial_tier(qty)].append(qty)
            else:
                counts[name] = counts.get(name, 0) + qty

    lines: list[dict] = []
    for name in ITEM_LIST:
        if name == AERIAL_ITEM or counts.get(name, 0) <= 0:
            continue
        qty = counts[name]
        rate = PAY_RATES[name]
        lines.append({
            "description": name,
            "qty": qty,
            "rate": rate,
            "amount": round(qty * rate, 2),
        })

    for tier, label, price in (
        ("0-300", "Aerial Drop (0-300')", AERIAL_TIER_1_PRICE),
        ("301-600", "Aerial Drop (301-600')", AERIAL_TIER_2_PRICE),
    ):
        drops = aerial[tier]
        if drops:
            lines.append({
                "description": f"{label} — {int(sum(drops))} ft total",
                "qty": len(drops),
                "rate": price,
                "amount": round(len(drops) * price, 2),
            })

    for feet in aerial["601+"]:
        price = aerial_drop_price(feet)
        lines.append({
            "description": f"Aerial Drop (601'+) — {int(feet)} ft",
            "qty": 1,
            "rate": price,
            "amount": round(price, 2),
        })

    for item in (extra_items or []):
        qty = float(item.get("qty") or 0)
        rate = float(item.get("rate") or 0)
        lines.append({
            "description": item.get("description") or item.get("desc") or "Custom item",
            "qty": qty,
            "rate": rate,
            "amount": round(qty * rate, 2),
        })

    return lines, round(sum(l["amount"] for l in lines), 2)

def custom_items_as_lines(items: list[dict]) -> list[dict]:
    lines = []
    for item in items:
        desc = f"{item['name']} - {item['description']}" if item.get("description") else item["name"]
        lines.append({
            "description": desc,
            "qty": item["qty"],
            "rate": item["rate"],
            "amount": item["total"],
        })
    return lines
