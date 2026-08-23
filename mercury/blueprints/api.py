"""JSON API.

This is the surface the offline client talks to. Every write endpoint is
idempotent on a client-supplied UUID, so the sync queue can retry freely.
"""
from __future__ import annotations

from datetime import date

from flask import Blueprint, jsonify, request, send_file

from .. import ai, invoicing
from ..config import Config
from ..db import current_seq
from ..email_service import EmailError, send_report
from ..exports import build_contractor_workbook, build_personal_workbook
from ..models import (delete_custom_item, delete_job, delete_scan, list_jobs,
                      list_custom_items, list_scans, parse_date, save_custom_item,
                      save_job, save_scan, week_bounds, week_summary)
from ..rates import ITEM_LIST, calculate_job_total, rate_table
from ..sync import devices, sync

bp = Blueprint("api", __name__, url_prefix="/api")


def _device() -> str:
    return request.headers.get("X-Device-Id", "") or (
        request.json.get("device_id", "") if request.is_json else "")


def _week_from_args() -> tuple[date, date]:
    start_arg = request.args.get("start") or (
        request.json.get("start") if request.is_json else None)
    return week_bounds(parse_date(start_arg) if start_arg else None)


# --------------------------------------------------------------------------
# Reference data — cached by the service worker so the app works cold offline
# --------------------------------------------------------------------------

@bp.get("/bootstrap")
def bootstrap():
    """Everything a freshly installed client needs before it goes offline."""
    start, end = week_bounds()
    return jsonify({
        "items": ITEM_LIST,
        "rates": rate_table(),
        "server_seq": current_seq(),
        "week": {"start": start.isoformat(), "end": end.isoformat()},
        "tech_name": Config.TECH_NAME,
        "ai_available": ai.available(),
        "email_configured": Config.email_configured(),
        "version": 2,
    })


@bp.post("/quote")
def quote():
    """Price a set of quantities without saving. Used for the live total on
    the job form when the device happens to be online; the client computes
    the same number locally when it is not."""
    items = (request.json or {}).get("items", {})
    return jsonify({"total": calculate_job_total(items)})


# --------------------------------------------------------------------------
# Sync
# --------------------------------------------------------------------------

@bp.post("/sync")
def sync_endpoint():
    payload = request.get_json(silent=True) or {}
    return jsonify(sync(payload))


@bp.get("/sync/status")
def sync_status():
    return jsonify({"ok": True, "server_seq": current_seq(), "devices": devices()})


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------

@bp.get("/jobs")
def api_list_jobs():
    start, end = _week_from_args()
    if request.args.get("all"):
        jobs = list_jobs(search=request.args.get("q", ""))
    else:
        jobs = list_jobs(start, end, search=request.args.get("q", ""))
    return jsonify({"jobs": jobs})


@bp.post("/jobs")
def api_save_job():
    job = save_job(request.get_json(silent=True) or {}, device_id=_device())
    return jsonify({"ok": True, "job": job, "server_seq": current_seq()})


@bp.delete("/jobs/<job_id>")
def api_delete_job(job_id):
    return jsonify({"ok": delete_job(job_id, device_id=_device()),
                    "server_seq": current_seq()})


# --------------------------------------------------------------------------
# Custom items
# --------------------------------------------------------------------------

@bp.get("/custom-items")
def api_list_customs():
    start, end = _week_from_args()
    return jsonify({"custom_items": list_custom_items(start, end)})


@bp.post("/custom-items")
def api_save_custom():
    item = save_custom_item(request.get_json(silent=True) or {}, device_id=_device())
    return jsonify({"ok": True, "custom_item": item, "server_seq": current_seq()})


@bp.delete("/custom-items/<item_id>")
def api_delete_custom(item_id):
    return jsonify({"ok": delete_custom_item(item_id, device_id=_device()),
                    "server_seq": current_seq()})


# --------------------------------------------------------------------------
# Equipment scans
# --------------------------------------------------------------------------

@bp.get("/scans")
def api_list_scans():
    return jsonify({"scans": list_scans()})


@bp.post("/scans")
def api_save_scan():
    return jsonify({"ok": True,
                    "scan": save_scan(request.get_json(silent=True) or {},
                                      device_id=_device())})


@bp.delete("/scans/<scan_id>")
def api_delete_scan(scan_id):
    return jsonify({"ok": delete_scan(scan_id, device_id=_device())})


@bp.post("/parse-equipment")
def api_parse_equipment():
    """Server-side AI parse. The client only calls this when online; offline
    it runs OCR in the browser and never touches this route."""
    files = request.files.getlist("images")
    if not files:
        return jsonify({"ok": False, "error": "No images were uploaded."}), 400

    from PIL import Image
    images = []
    for f in files:
        try:
            img = Image.open(f.stream)
            img.load()
            images.append(img)
        except Exception:
            continue
    if not images:
        return jsonify({"ok": False, "error": "Those files could not be read as images."}), 400

    try:
        return jsonify({"ok": True, "text": ai.parse_equipment_images(images),
                        "source": "ai"})
    except ai.AIUnavailable as exc:
        return jsonify({"ok": False, "error": str(exc), "fallback": "offline"}), 503
    except Exception as exc:
        return jsonify({"ok": False, "error": f"AI parse failed: {exc}",
                        "fallback": "offline"}), 502


# --------------------------------------------------------------------------
# Summary, exports, email
# --------------------------------------------------------------------------

@bp.get("/summary")
def api_summary():
    start, end = _week_from_args()
    summary = week_summary(start, end)
    summary.pop("jobs", None)
    summary.pop("customs", None)
    return jsonify(summary)


@bp.get("/export/<kind>")
def api_export(kind):
    start, end = _week_from_args()
    if kind == "contractor":
        path = build_contractor_workbook(start, end)
    elif kind == "personal":
        path = build_personal_workbook(start, end)
    else:
        return jsonify({"ok": False, "error": "Unknown export type."}), 404
    return send_file(path, as_attachment=True, download_name=path.name)


@bp.post("/email/<kind>")
def api_email(kind):
    start, end = _week_from_args()
    summary = week_summary(start, end)
    try:
        if kind == "contractor":
            path = build_contractor_workbook(start, end)
            send_report(
                Config.CONTRACTOR_EMAIL,
                f"Weekly Installation Report — {summary['range_label']}",
                f"Attached is the installation tracker for {summary['range_label']}.",
                [("Week", summary["range_label"]),
                 ("Jobs logged", str(summary["job_count"])),
                 ("Technician", Config.TECH_NAME)],
                [path],
            )
            recipient = Config.CONTRACTOR_EMAIL
        elif kind == "personal":
            path = build_personal_workbook(start, end)
            send_report(
                Config.YOUR_EMAIL,
                f"Personal Pay Report — {summary['range_label']}",
                f"Your pay backup for {summary['range_label']}.",
                [("Week", summary["range_label"]),
                 ("Jobs logged", str(summary["job_count"])),
                 ("Week total", f"${summary['weekly']:,.2f}")],
                [path],
            )
            recipient = Config.YOUR_EMAIL
        else:
            return jsonify({"ok": False, "error": "Unknown report type."}), 404
    except EmailError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "message": f"Sent to {recipient}."})


@bp.post("/invoice/<invoice_id>/email")
def api_email_invoice(invoice_id):
    invoice = invoicing.get_invoice(invoice_id)
    if not invoice:
        return jsonify({"ok": False, "error": "Invoice not found."}), 404
    path = Config.EXPORT_DIR / invoice["filename"]
    label = "Mercury" if invoice["kind"] == "mercury" else "REMC"
    try:
        send_report(
            Config.CONTRACTOR_EMAIL,
            f"{label} Invoice {invoice['number']} — due {invoice['due_date']}",
            f"Please find invoice {invoice['number']} attached.",
            [("Invoice", invoice["number"]),
             ("Due date", invoice["due_date"]),
             ("Balance due", f"${invoice['total']:,.2f}")],
            [path],
        )
    except EmailError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    invoicing.mark_emailed(invoice_id)
    return jsonify({"ok": True, "message": f"Invoice emailed to {Config.CONTRACTOR_EMAIL}."})
