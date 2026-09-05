"""The Settings "generate today's list" button.

The point of the button is to stand in for the 8pm email: generating the
list early has to stop those same jobs being emailed again at 8pm, without
swallowing jobs logged later in the day. That is per-job state
(jobs.dispatched_at), not a per-day flag, and these tests pin the
difference — a whole-day marker would pass the first test here and fail the
third.
"""
from datetime import date
from unittest.mock import patch

from mercury.models import save_job


def _job(address, **flags):
    return save_job({
        "work_date": date.today().isoformat(), "address": address,
        "order_number": flags.pop("order", "X1"),
        "items": {"Installation": 1}, **flags,
    })


def _dispatched(job_id):
    from mercury.db import get_db
    row = get_db().execute(
        "SELECT dispatched_at FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return row["dispatched_at"]


# ------------------------------------------------------- the button itself

def test_manual_run_emails_todays_flagged_jobs(ctx):
    from mercury import send_daily_dispatch_report

    _job("100 Buried Ln", needs_buried=1)
    _job("200 Bore Rd", needs_bore=1)

    with patch("mercury.email_service.send_email") as mock_send:
        result = send_daily_dispatch_report()

    assert mock_send.call_count == 1
    body = mock_send.call_args.args[2]
    assert "100 Buried Ln" in body and "200 Bore Rd" in body
    assert result["sent"] is True and result["count"] == 2


def test_manual_run_reports_nothing_when_no_jobs_are_flagged(ctx):
    from mercury import send_daily_dispatch_report

    _job("No flags here")

    with patch("mercury.email_service.send_email") as mock_send:
        result = send_daily_dispatch_report()

    assert mock_send.call_count == 0
    assert result["sent"] is False
    assert result["reason"] == "nothing-to-report"


def test_manual_run_marks_only_the_jobs_it_reported(ctx):
    from mercury import send_daily_dispatch_report

    flagged = _job("300 Flagged St", needs_bore=1)
    plain = _job("400 Ordinary Ave")

    with patch("mercury.email_service.send_email"):
        send_daily_dispatch_report()

    assert _dispatched(flagged["id"]) is not None
    assert _dispatched(plain["id"]) is None


# ------------------------------- the actual ask: no 8pm email for those jobs

def test_the_8pm_send_skips_jobs_already_generated_manually(ctx):
    from mercury import send_daily_dispatch_report

    _job("500 Early Bird Dr", needs_buried=1)

    with patch("mercury.email_service.send_email") as manual_send:
        send_daily_dispatch_report()
    assert manual_send.call_count == 1

    # 8pm rolls around.
    with patch("mercury.email_service.send_email") as scheduled_send:
        send_daily_dispatch_report()

    assert scheduled_send.call_count == 0, (
        "the 8pm email re-sent jobs the manual run already covered")


def test_a_job_logged_after_the_manual_run_still_goes_out_at_8pm(ctx):
    """The reason this is per-job and not a per-day flag: work logged after
    an early manual run must not be silently dropped for the day."""
    from mercury import send_daily_dispatch_report

    _job("600 Morning Job Ct", needs_buried=1)
    with patch("mercury.email_service.send_email"):
        send_daily_dispatch_report()

    _job("700 Afternoon Job Way", needs_bore=1)

    with patch("mercury.email_service.send_email") as scheduled_send:
        send_daily_dispatch_report()

    assert scheduled_send.call_count == 1
    body = scheduled_send.call_args.args[2]
    assert "700 Afternoon Job Way" in body
    assert "600 Morning Job Ct" not in body, "already reported this morning"


def test_manual_run_works_even_after_the_8pm_send_has_run(ctx):
    """The button stays usable late in the evening: a send earlier in the day
    doesn't lock out the rest of it."""
    from mercury import send_daily_dispatch_report

    _job("800 Evening Dr", needs_buried=1)
    with patch("mercury.email_service.send_email"):
        send_daily_dispatch_report()

    _job("900 Later Still Blvd", needs_bore=1)

    with patch("mercury.email_service.send_email") as manual_send:
        result = send_daily_dispatch_report()

    assert manual_send.call_count == 1
    assert "900 Later Still Blvd" in manual_send.call_args.args[2]
    assert result["sent"] is True


def test_a_failed_manual_send_leaves_the_jobs_for_the_8pm_retry(ctx):
    from mercury import send_daily_dispatch_report

    job = _job("1000 Smtp Down Rd", needs_buried=1)

    with patch("mercury.email_service.send_email", side_effect=RuntimeError("smtp down")):
        result = send_daily_dispatch_report()

    assert result["ok"] is False
    assert _dispatched(job["id"]) is None, "a failed send must not mark the job done"

    with patch("mercury.email_service.send_email") as retry:
        send_daily_dispatch_report()
    assert retry.call_count == 1


# ------------------------------------------------------------- the endpoint

def test_endpoint_sends_and_returns_the_addresses(client):
    _job("1100 Endpoint Way", needs_buried=1)

    with patch("mercury.email_service.send_email") as mock_send:
        response = client.post("/api/dispatch/send-now")

    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True and data["sent"] is True
    assert any("1100 Endpoint Way" in line for line in data["buried"])
    assert mock_send.call_count == 1


def test_endpoint_reports_a_send_failure_as_an_error(client):
    _job("1200 Broken Smtp Ln", needs_bore=1)

    with patch("mercury.email_service.send_email", side_effect=RuntimeError("smtp down")):
        response = client.post("/api/dispatch/send-now")

    assert response.status_code == 400
    assert response.get_json()["ok"] is False


def test_endpoint_is_a_quiet_noop_with_nothing_flagged(client):
    _job("1300 Nothing To See Here")

    with patch("mercury.email_service.send_email") as mock_send:
        response = client.post("/api/dispatch/send-now")

    assert response.status_code == 200
    assert response.get_json()["sent"] is False
    assert mock_send.call_count == 0


# --------------------------------------------------------------- migration

def test_an_existing_database_gains_the_column(tmp_path, monkeypatch):
    """The live database predates this column. Patch Config.DB_PATH (a class
    attribute read at connect time) rather than any module-level global, so
    nothing here can leak into another test's imports."""
    import sqlite3

    from mercury.config import Config
    from mercury.db import close_db, get_db, init_db

    old_db = tmp_path / "old.db"
    conn = sqlite3.connect(old_db)
    conn.executescript("""
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE jobs (
            id TEXT PRIMARY KEY, work_date TEXT NOT NULL,
            address TEXT NOT NULL DEFAULT '', order_number TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '{}',
            total REAL NOT NULL DEFAULT 0,
            needs_buried INTEGER NOT NULL DEFAULT 0,
            needs_bore INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'complete',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            device_id TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT 0
        );
    """)
    conn.execute(
        "INSERT INTO jobs (id, work_date, address, needs_buried, created_at, updated_at) "
        "VALUES ('old-1', ?, '1 Legacy Rd', 1, '', '')", (date.today().isoformat(),))
    conn.commit()
    conn.close()

    close_db()
    monkeypatch.setattr(Config, "DB_PATH", old_db)
    try:
        init_db()
        columns = [c[1] for c in get_db().execute("PRAGMA table_info(jobs)").fetchall()]
        assert "dispatched_at" in columns
        # Pre-existing rows read as "not yet dispatched" rather than erroring.
        assert _dispatched("old-1") is None
    finally:
        close_db()
