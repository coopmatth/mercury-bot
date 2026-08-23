"""Page routes."""
from __future__ import annotations

from datetime import date

from flask import (Blueprint, current_app, flash, jsonify, make_response,
                   redirect, render_template, request, send_file, url_for)

from .. import ai, invoicing
from ..config import BASE_DIR, Config
from ..build import build_id
from ..db import backup_to, current_seq
from ..models import (last_completed_week, list_custom_items, list_jobs,
                      list_scans, parse_date, recent_weeks, week_bounds,
                      week_summary)
from ..rates import ITEM_LIST, rate_table
from ..sync import devices

bp = Blueprint("web", __name__)


def _selected_week(default_to_last_completed: bool = False) -> tuple[date, date]:
    start_arg = request.args.get("week")
    if start_arg:
        return week_bounds(parse_date(start_arg))
    if default_to_last_completed:
        return last_completed_week()
    return week_bounds()


@bp.app_context_processor
def inject_globals():
    return {
        "ai_available": ai.available(),
        "ai_load_error": ai.load_error(),
        "demo_mode": Config.DEMO,
        "email_configured": Config.email_configured() or Config.DEMO,
        "app_version": current_app.config.get("VERSION", "2.0.0"),
    }


@bp.get("/")
def dashboard():
    start, end = _selected_week()
    return render_template(
        "dashboard.html",
        summary=week_summary(start, end),
        weeks=recent_weeks(),
        selected_week=start.isoformat(),
    )


@bp.get("/jobs")
def jobs_page():
    start, end = _selected_week()
    return render_template(
        "jobs.html",
        summary=week_summary(start, end),
        weeks=recent_weeks(),
        selected_week=start.isoformat(),
        query=request.args.get("q", ""),
    )


@bp.get("/jobs/new")
def new_job():
    return render_template("job_form.html", job=None, rates=rate_table(),
                           today=date.today().isoformat())


@bp.get("/jobs/<job_id>/edit")
def edit_job(job_id):
    from ..models import get_job
    job = get_job(job_id)
    if not job:
        flash("That job could not be found.", "danger")
        return redirect(url_for("web.jobs_page"))
    return render_template("job_form.html", job=job, rates=rate_table(),
                           today=date.today().isoformat())


@bp.get("/custom")
def custom_page():
    start, end = _selected_week()
    return render_template("custom.html", items=list_custom_items(start, end),
                           today=date.today().isoformat(),
                           selected_week=start.isoformat(),
                           week_start_iso=start.isoformat(),
                           week_end_iso=end.isoformat())


@bp.get("/scanner")
def scanner_page():
    return render_template("scanner.html", scans=list_scans(25))


@bp.get("/photos")
def photos_page():
    return render_template("photos.html")


@bp.get("/reports")
def reports_page():
    start, end = _selected_week(default_to_last_completed=True)
    return render_template(
        "reports.html",
        summary=week_summary(start, end),
        weeks=recent_weeks(),
        selected_week=start.isoformat(),
        invoices=invoicing.list_invoices(),
        default_due=invoicing.default_due_date(end).strftime("%m/%d/%y"),
    )


@bp.post("/invoice/mercury")
def create_mercury_invoice():
    start, end = _selected_week(default_to_last_completed=True)
    extra = invoicing.parse_line_inputs(
        request.form.getlist("desc[]"),
        request.form.getlist("qty[]"),
        request.form.getlist("rate[]"),
    )
    try:
        invoice = invoicing.build_mercury_invoice(
            start, end, extra,
            due_date=request.form.get("due_date", "").strip(),
        )
    except ValueError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("web.reports_page", week=start.isoformat()))
    return redirect(url_for("web.invoice_preview", invoice_id=invoice["id"]))


@bp.post("/invoice/remc")
def create_remc_invoice():
    start, end = _selected_week(default_to_last_completed=True)
    extra = invoicing.parse_line_inputs(
        request.form.getlist("desc[]"),
        request.form.getlist("qty[]"),
        request.form.getlist("rate[]"),
    )
    try:
        invoice = invoicing.build_remc_invoice(
            extra,
            due_date=request.form.get("due_date", "").strip(),
            start=start, end=end,
        )
    except ValueError as exc:
        flash(str(exc), "danger")
        return redirect(url_for("web.reports_page", week=start.isoformat()))
    return redirect(url_for("web.invoice_preview", invoice_id=invoice["id"]))


@bp.get("/invoice/<invoice_id>")
def invoice_preview(invoice_id):
    invoice = invoicing.get_invoice(invoice_id)
    if not invoice:
        flash("That invoice could not be found.", "danger")
        return redirect(url_for("web.reports_page"))
    return render_template("invoice_preview.html", invoice=invoice)


@bp.get("/invoice/<invoice_id>/pdf")
def invoice_pdf(invoice_id):
    invoice = invoicing.get_invoice(invoice_id)
    if not invoice:
        return "Not found", 404
    path = Config.EXPORT_DIR / invoice["filename"]
    if not path.exists():
        return "The PDF for this invoice is no longer on disk.", 404
    return send_file(str(path.resolve()), mimetype="application/pdf",
                     download_name=invoice["filename"],
                     as_attachment=bool(request.args.get("download")))


@bp.get("/settings")
def settings_page():
    return render_template(
        "settings.html",
        rates=rate_table(),
        devices=devices(),
        server_seq=current_seq(),
        config={
            "tech_name": Config.TECH_NAME,
            "tech_email": Config.TECH_EMAIL,
            "contractor_email": Config.CONTRACTOR_EMAIL,
            "your_email": Config.YOUR_EMAIL,
            "smtp_server": Config.SMTP_SERVER,
            "gemini_model": Config.GEMINI_MODEL,
            "data_dir": str(Config.DATA_DIR),
        },
    )


@bp.get("/settings/backup")
def download_backup():
    path = backup_to(Config.EXPORT_DIR / f"mercury-backup-{date.today().isoformat()}.db")
    return send_file(str(path.resolve()), as_attachment=True, download_name=path.name)


@bp.post("/settings/demo-reset")
def reset_demo():
    if not Config.DEMO:
        flash("Demo reset is only available in demo mode.", "danger")
        return redirect(url_for("web.settings_page"))
    from ..demo import reset
    flash(f"Demo data reset — {reset()} sample jobs regenerated. "
          "Clear the app's local data on each device to match.", "success")
    return redirect(url_for("web.settings_page"))


@bp.get("/offline")
def offline_page():
    return render_template("offline.html")


@bp.get("/manifest.webmanifest")
def manifest():
    response = jsonify({
        "name": "Mercury Tracker",
        "short_name": "Mercury",
        "description": "Offline-first field job tracking, pay and invoicing.",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "portrait",
        "background_color": "#0B1120",
        "theme_color": "#0B1120",
        "categories": ["business", "productivity"],
        "icons": [
            {"src": "/static/icons/logo.png", "sizes": "192x192", "type": "image/png",
             "purpose": "any"},
            {"src": "/static/icons/logo.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": "Log a job", "url": "/jobs/new"},
            {"name": "Scan equipment", "url": "/scanner"},
            {"name": "This week", "url": "/reports"},
        ],
    })
    response.headers["Content-Type"] = "application/manifest+json"
    return response


@bp.get("/sw.js")
def service_worker():
    source = (BASE_DIR / "static" / "js" / "sw.js").read_text()
    response = make_response(
        source.replace("__MERCURY_BUILD__", f"v{build_id()}"))
    response.headers["Content-Type"] = "application/javascript"
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


@bp.get("/healthz")
def healthz():
    return jsonify({"ok": True, "seq": current_seq()})
