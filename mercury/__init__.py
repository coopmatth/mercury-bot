"""Mercury Tracker — offline-first field job tracking, pay and invoicing."""
from __future__ import annotations

import threading
import time
from datetime import datetime
from flask import Flask

from .config import Config

__version__ = "2.0.0"

# Set once the scheduler thread has been started, so a process that calls
# create_app() more than once (every test in the suite does) never ends up
# with a second thread polling in the background.
_dispatch_scheduler_started = False


def start_daily_dispatch_scheduler(app):
    global _dispatch_scheduler_started
    if _dispatch_scheduler_started:
        return
    _dispatch_scheduler_started = True

    def dispatch_worker():
        while True:
            try:
                if datetime.now().hour == 20:
                    with app.app_context():
                        send_daily_dispatch_report()
            except Exception as exc:
                print(f"Dispatch scheduler tick failed: {exc}")
            time.sleep(60)

    t = threading.Thread(target=dispatch_worker, daemon=True)
    t.start()


def send_daily_dispatch_report() -> dict:
    """Email any of today's needs-buried / needs-bore addresses that haven't
    been reported yet.

    De-duped per job (jobs.dispatched_at), not per day. That is what lets the
    Settings button stand in for the 8pm email: generating the list at 2pm
    marks those jobs reported, so the scheduled send skips them — while a job
    logged at 4pm is still picked up at 8pm rather than being dropped.

    Because the dedupe is per job, the manual button and the scheduled send
    are the same operation; only the trigger differs. This deliberately
    replaces an earlier per-day 'last_dispatch_date' marker, which could
    silently swallow a whole evening's work: once the 8pm poll had recorded
    the day as handled — which it did even on a day with nothing to report —
    every job logged afterwards was skipped until the next morning.

    Returns a summary of what happened; the scheduler ignores it, the API
    route reports it back to the page.
    """
    from .db import get_db, utcnow
    from .email_service import send_email
    today_str = datetime.now().strftime("%Y-%m-%d")
    conn = get_db()

    jobs = conn.execute(
        "SELECT id, address, order_number, needs_buried, needs_bore, notes "
        "FROM jobs WHERE work_date = ? AND deleted = 0 "
        "AND (needs_buried = 1 OR needs_bore = 1) AND dispatched_at IS NULL",
        (today_str,)
    ).fetchall()

    if not jobs:
        return {"ok": True, "sent": False, "reason": "nothing-to-report",
                "buried": [], "bore": [], "count": 0}

    buried_list = [f"• {j['address']} (Order #{j['order_number']})" for j in jobs if j['needs_buried']]
    bore_list = [f"• {j['address']} (Order #{j['order_number']})" for j in jobs if j['needs_bore']]

    body = f"Daily Field Dispatch Report — {today_str}\n\n"
    if buried_list:
        body += "--- NEEDS BURIED ---\n" + "\n".join(buried_list) + "\n\n"
    if bore_list:
        body += "--- NEEDS BORE ---\n" + "\n".join(bore_list) + "\n\n"

    subject = f"Daily Drop Report: Needs Buried / Bore — {today_str}"
    try:
        send_email(Config.YOUR_EMAIL, subject, body)
    except Exception as e:
        print(f"Failed to send dispatch report: {e}")
        # Mark nothing: leave the jobs undispatched so the next run retries.
        return {"ok": False, "sent": False, "error": str(e)}

    # Only now that the mail is away are these jobs accounted for.
    conn.execute(
        "UPDATE jobs SET dispatched_at = ? WHERE id IN "
        f"({','.join('?' for _ in jobs)})",
        [utcnow()] + [j["id"] for j in jobs],
    )
    conn.commit()

    return {"ok": True, "sent": True, "count": len(jobs),
            "buried": buried_list, "bore": bore_list,
            "recipient": Config.YOUR_EMAIL}

def create_app(config: type[Config] = Config) -> Flask:
    app = Flask(
        __name__,
        static_folder="../static",
        template_folder="../templates",
        static_url_path="/static",
    )
    app.config.from_object(config)
    app.secret_key = config.SECRET_KEY
    app.config["JSON_SORT_KEYS"] = False
    app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB of label photos

    config.ensure_dirs()

    from .db import close_db, init_db
    with app.app_context():
        init_db()
        if config.DEMO:
            from .demo import seed_if_empty
            seed_if_empty()
    app.teardown_appcontext(close_db)

    from .blueprints.api import bp as api_bp
    from .blueprints.web import bp as web_bp
    app.register_blueprint(web_bp)
    app.register_blueprint(api_bp)

    from .filters import register_filters
    register_filters(app)

    start_daily_dispatch_scheduler(app)

    return app
