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
                if datetime.now().hour == 18:18
                    with app.app_context():
                        send_daily_dispatch_report()
            except Exception as exc:
                print(f"Dispatch scheduler tick failed: {exc}")
            time.sleep(60)

    t = threading.Thread(target=dispatch_worker, daemon=True)
    t.start()


def send_daily_dispatch_report():
    from .db import get_db
    from .email_service import send_email
    today_str = datetime.now().strftime("%Y-%m-%d")
    conn = get_db()

    # Persisted de-dupe: safe to call this every minute during the 8pm hour,
    # and safe across a restart that happens to land right after a send —
    # neither can produce a second email for the same day.
    sent = conn.execute(
        "SELECT value FROM meta WHERE key = 'last_dispatch_date'").fetchone()
    if sent and sent["value"] == today_str:
        return

    jobs = conn.execute(
        "SELECT address, order_number, needs_buried, needs_bore, notes FROM jobs WHERE work_date = ? AND deleted = 0 AND (needs_buried = 1 OR needs_bore = 1)",
        (today_str,)
    ).fetchall()

    if not jobs:
        # Nothing to report today, either — no need to keep checking on
        # every poll for the rest of the hour.
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES "
                     "('last_dispatch_date', ?)", (today_str,))
        conn.commit()
        return

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
        return  # leave last_dispatch_date unset so the next poll retries

    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES "
                 "('last_dispatch_date', ?)", (today_str,))
    conn.commit()

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
