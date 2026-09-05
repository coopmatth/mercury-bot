"""The daily dispatch email spawned a new background thread on every
create_app() call, with no guard against sending twice on the same day.
These tests pin both fixes."""
import threading
from datetime import date
from unittest.mock import patch

from mercury.models import save_job


def test_create_app_starts_the_scheduler_at_most_once(ctx):
    """create_app() runs dozens of times over the test session alone; only
    one background thread should ever exist for the whole process."""
    import mercury as mercury_pkg
    from mercury import create_app

    assert mercury_pkg._dispatch_scheduler_started is True

    before = threading.active_count()
    create_app()
    create_app()
    create_app()
    # None of those calls should have started a second thread.
    assert threading.active_count() == before


def test_dispatch_report_sends_once_for_flagged_jobs(ctx):
    from mercury import send_daily_dispatch_report

    save_job({
        "work_date": date.today().isoformat(), "address": "123 Test St",
        "order_number": "X1", "items": {"Installation": 1}, "needs_buried": 1,
    })

    with patch("mercury.email_service.send_email") as mock_send:
        send_daily_dispatch_report()
        send_daily_dispatch_report()
        send_daily_dispatch_report()

    assert mock_send.call_count == 1
    recipient, subject, body = mock_send.call_args.args[:3]
    assert "123 Test St" in body
    assert "NEEDS BURIED" in body


def test_dispatch_report_is_a_noop_with_nothing_flagged(ctx):
    """Nothing flagged means no email — and, since the day is no longer
    marked as handled, a job flagged later the same evening is still picked
    up rather than being held until tomorrow."""
    from mercury import send_daily_dispatch_report

    save_job({
        "work_date": date.today().isoformat(), "address": "No flags here",
        "items": {"Installation": 1},
    })

    with patch("mercury.email_service.send_email") as mock_send:
        send_daily_dispatch_report()
    assert mock_send.call_count == 0

    save_job({
        "work_date": date.today().isoformat(), "address": "Flagged at 8:15pm",
        "items": {"Installation": 1}, "needs_bore": 1,
    })

    with patch("mercury.email_service.send_email") as later_send:
        send_daily_dispatch_report()
    assert later_send.call_count == 1
    assert "Flagged at 8:15pm" in later_send.call_args.args[2]


def test_a_failed_send_is_retried_not_marked_done(ctx):
    from mercury import send_daily_dispatch_report
    from mercury.db import get_db

    job = save_job({
        "work_date": date.today().isoformat(), "address": "Retry me",
        "items": {"Installation": 1}, "needs_bore": 1,
    })

    with patch("mercury.email_service.send_email", side_effect=RuntimeError("smtp down")):
        send_daily_dispatch_report()

    row = get_db().execute(
        "SELECT dispatched_at FROM jobs WHERE id = ?", (job["id"],)).fetchone()
    assert row["dispatched_at"] is None, "a failed send must not be marked as delivered"

    with patch("mercury.email_service.send_email") as mock_send:
        send_daily_dispatch_report()
    assert mock_send.call_count == 1
