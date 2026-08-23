"""Invoice assembly: numbering, due dates, line items, persistence."""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from .config import Config
from .db import get_db, new_id, utcnow
from .exports.pdf import build_invoice_pdf
from .models import (custom_items_as_lines, invoice_lines, list_custom_items,
                     parse_date, week_bounds)

NET_TERMS_DAYS = 14
WORK_WEEK_END_WEEKDAY = 4

def work_week_end(week_end: date) -> date:
    return week_end - timedelta(
        days=(week_end.weekday() - WORK_WEEK_END_WEEKDAY) % 7)

def default_due_date(week_end: date) -> date:
    return work_week_end(week_end) + timedelta(days=NET_TERMS_DAYS)

def _next_number(kind: str, issued: date) -> str:
    prefix = "INV" if kind == "mercury" else "REMC-INV"
    stamp = issued.strftime("%Y%m%d")
    count = get_db().execute(
        "SELECT COUNT(*) AS n FROM invoices WHERE kind = ? AND created_at LIKE ?",
        (kind, f"{issued.strftime('%Y-%m-%d')}%"),
    ).fetchone()["n"]
    suffix = f"-{count + 1}" if count else ""
    return f"{prefix}{stamp}{suffix}"

def _record(kind: str, number: str, start: date | None, end: date | None,
            due: str, total: float, filename: str) -> dict:
    conn = get_db()
    row_id = new_id()
    with conn:
        conn.execute(
            """INSERT INTO invoices (id, kind, number, period_start, period_end,
                                     due_date, total, filename, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (row_id, kind, number,
             start.strftime("%Y-%m-%d") if start else "",
             end.strftime("%Y-%m-%d") if end else "",
             due, total, filename, utcnow()),
        )
    return dict(conn.execute("SELECT * FROM invoices WHERE id = ?", (row_id,)).fetchone())

def build_mercury_invoice(start: date, end: date,
                          extra_items: list[dict] | None = None,
                          due_date: str = "") -> dict:
    customs = custom_items_as_lines(list_custom_items(start, end, bill_to="mercury"))
    lines, total = invoice_lines(start, end, (extra_items or []) + customs)
    if not lines:
        raise ValueError("There is nothing to invoice for this week yet.")

    issued = date.today()
    due = due_date or default_due_date(end).strftime("%m/%d/%y")
    number = _next_number("mercury", issued)
    filename = f"Invoice_{start.strftime('%m-%d-%y')}_to_{end.strftime('%m-%d-%y')}.pdf"

    build_invoice_pdf(
        filename=filename, number=number, lines=lines, total=total,
        issued=issued, due=due,
        period=f"{start.strftime('%m/%d/%y')} - {end.strftime('%m/%d/%y')}",
    )
    return _record("mercury", number, start, end, due, total, filename)

def build_remc_invoice(extra_items: list[dict] | None = None,
                       due_date: str = "",
                       start: date | None = None, end: date | None = None) -> dict:
    if start is None or end is None:
        start, end = week_bounds()
    customs = custom_items_as_lines(list_custom_items(start, end, bill_to="remc"))
    lines = customs + [
        {
            "description": i.get("description") or i.get("desc") or "Custom item",
            "qty": float(i.get("qty") or 0),
            "rate": float(i.get("rate") or 0),
            "amount": round(float(i.get("qty") or 0) * float(i.get("rate") or 0), 2),
        }
        for i in (extra_items or [])
    ]
    if not lines:
        raise ValueError(
            "No REMC items to invoice. Add custom items billed to REMC, or "
            "enter lines directly on this screen."
        )

    total = round(sum(l["amount"] for l in lines), 2)
    issued = date.today()
    due = due_date or default_due_date(end).strftime("%m/%d/%y")
    number = _next_number("remc", issued)
    filename = f"REMC_Invoice_{issued.strftime('%Y-%m-%d')}.pdf"

    build_invoice_pdf(
        filename=filename, number=number, lines=lines, total=total,
        issued=issued, due=due, period="",
    )
    return _record("remc", number, start, end, due, total, filename)

def list_invoices(limit: int = 50) -> list[dict]:
    rows = get_db().execute(
        "SELECT * FROM invoices ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]

def get_invoice(invoice_id: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    return dict(row) if row else None

def delete_invoice(invoice_id: str) -> bool:
    invoice = get_invoice(invoice_id)
    if not invoice:
        return False
    
    # Remove physical PDF file
    path = Config.EXPORT_DIR / invoice["filename"]
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass

    # Remove from database
    conn = get_db()
    with conn:
        conn.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
    return True

def mark_emailed(invoice_id: str) -> None:
    conn = get_db()
    with conn:
        conn.execute("UPDATE invoices SET emailed_at = ? WHERE id = ?",
                     (utcnow(), invoice_id))

def parse_line_inputs(descs, qtys, rates) -> list[dict]:
    out = []
    for desc, qty, rate in zip(descs, qtys, rates):
        if not (desc or "").strip():
            continue
        try:
            out.append({
                "description": desc.strip(),
                "qty": float(qty or 0),
                "rate": float(rate or 0),
            })
        except (TypeError, ValueError):
            continue
    return out
