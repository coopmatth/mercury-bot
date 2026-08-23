"""Route smoke tests, week math, and the export/invoice pipeline."""
import re
from datetime import date, timedelta

import pytest

from mercury.models import (invoice_lines, parse_date, save_custom_item,
                            save_job, week_bounds, week_summary)


PAGES = ["/", "/jobs", "/jobs/new", "/custom", "/scanner", "/photos",
         "/reports", "/settings", "/offline", "/healthz",
         "/manifest.webmanifest", "/sw.js"]


@pytest.mark.parametrize("path", PAGES)
def test_pages_render(client, path):
    assert client.get(path).status_code == 200


def test_manifest_is_installable(client):
    manifest = client.get("/manifest.webmanifest").get_json()
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "/"
    assert manifest["icons"]


def test_service_worker_is_served_from_the_root_scope(client):
    """A worker served from /static could only control /static."""
    response = client.get("/sw.js")
    assert response.headers["Service-Worker-Allowed"] == "/"
    assert "javascript" in response.headers["Content-Type"]


def test_bootstrap_gives_a_cold_client_what_it_needs(client):
    data = client.get("/api/bootstrap").get_json()
    assert data["items"] and data["rates"]
    assert "server_seq" in data and "week" in data


def test_pay_week_runs_sunday_to_saturday(ctx):
    start, end = week_bounds(date(2026, 8, 26))     # a Wednesday
    assert start == date(2026, 8, 23)               # the Sunday before
    assert end == date(2026, 8, 29)                 # the Saturday after
    assert start.weekday() == 6 and end.weekday() == 5


def test_a_sunday_starts_its_own_week(ctx):
    start, _ = week_bounds(date(2026, 8, 23))
    assert start == date(2026, 8, 23)


def test_parse_date_accepts_the_formats_the_app_emits():
    assert parse_date("2026-08-23") == date(2026, 8, 23)
    assert parse_date("08/23/2026") == date(2026, 8, 23)
    assert parse_date("") == date.today()
    assert parse_date("garbage", date(2020, 1, 1)) == date(2020, 1, 1)


def test_week_summary_totals_jobs_and_custom_items(ctx):
    start, end = week_bounds()
    save_job({"work_date": start.isoformat(), "address": "A",
              "items": {"Installation": 2}})                       # 220
    save_job({"work_date": start.isoformat(), "address": "B",
              "items": {"Aerial Drop Footage": 700}})              # 199.50
    save_custom_item({"work_date": start.isoformat(), "name": "Extra",
                      "qty": 2, "rate": 45})                       # 90

    summary = week_summary(start, end)
    assert summary["jobs_total"] == pytest.approx(419.5)
    assert summary["custom_total"] == pytest.approx(90.0)
    assert summary["weekly"] == pytest.approx(509.5)
    assert summary["job_count"] == 2
    assert len(summary["per_day"]) == 7


def test_work_outside_the_week_is_excluded(ctx):
    start, end = week_bounds()
    save_job({"work_date": (start - timedelta(days=1)).isoformat(),
              "items": {"Installation": 1}})
    assert week_summary(start, end)["job_count"] == 0


def test_invoice_groups_aerial_by_tier_and_bills_long_drops_singly(ctx):
    start, end = week_bounds()
    for feet in (200, 250, 400, 780):
        save_job({"work_date": start.isoformat(),
                  "items": {"Aerial Drop Footage": feet}})

    lines, total = invoice_lines(start, end)
    by_desc = {line["description"]: line for line in lines}

    tier1 = next(v for k, v in by_desc.items() if k.startswith("Aerial Drop (0-300')"))
    assert tier1["qty"] == 2 and tier1["amount"] == pytest.approx(150.0)

    tier2 = next(v for k, v in by_desc.items() if k.startswith("Aerial Drop (301-600')"))
    assert tier2["qty"] == 1 and tier2["amount"] == pytest.approx(150.0)

    # 780 ft = 150 + (780 - 601) * 0.50 = 239.50, on its own line.
    long_drop = next(v for k, v in by_desc.items() if "601'+" in k)
    assert long_drop["amount"] == pytest.approx(239.5)
    assert total == pytest.approx(539.5)


def test_remc_items_stay_off_the_mercury_invoice(ctx):
    from mercury.invoicing import build_mercury_invoice, build_remc_invoice
    start, end = week_bounds()
    save_job({"work_date": start.isoformat(), "items": {"Installation": 1}})   # 110
    save_custom_item({"work_date": start.isoformat(), "name": "Mercury extra",
                      "qty": 1, "rate": 40, "bill_to": "mercury"})
    save_custom_item({"work_date": start.isoformat(), "name": "REMC repair",
                      "qty": 1, "rate": 180, "bill_to": "remc"})

    mercury = build_mercury_invoice(start, end)
    remc = build_remc_invoice(start=start, end=end)
    assert mercury["total"] == pytest.approx(150.0)   # 110 + 40, no REMC line
    assert remc["total"] == pytest.approx(180.0)


def test_invoice_refuses_to_bill_an_empty_week(ctx):
    from mercury.invoicing import build_mercury_invoice
    start, end = week_bounds()
    with pytest.raises(ValueError):
        build_mercury_invoice(start, end)


def test_terms_are_net_14_from_the_close_of_the_billed_week(ctx):
    """The week ending Sat 08/22/26 closed Fri 08/21/26 and is due Fri 09/04/26."""
    from mercury.invoicing import NET_TERMS_DAYS, default_due_date
    assert NET_TERMS_DAYS == 14
    assert default_due_date(date(2026, 8, 22)) == date(2026, 9, 4)
    assert default_due_date(date(2026, 8, 29)) == date(2026, 9, 11)
    assert default_due_date(date(2026, 12, 26)) == date(2027, 1, 8)  # crosses a year


@pytest.mark.parametrize("week_end", [
    date(2026, 1, 3), date(2026, 2, 28), date(2026, 8, 22),
    date(2026, 12, 26), date(2027, 7, 31),
])
def test_due_date_always_lands_on_a_friday(ctx, week_end):
    from mercury.invoicing import default_due_date
    due = default_due_date(week_end)
    assert due.weekday() == 4, f"{due} is a {due.strftime('%A')}"
    assert 13 <= (due - week_end).days <= 14


def test_due_date_does_not_move_with_the_day_you_raise_the_invoice(ctx):
    """Terms run from the billed week, not from whenever the PDF is made."""
    from datetime import datetime
    from mercury.invoicing import build_mercury_invoice
    from mercury.models import last_completed_week
    start, end = last_completed_week()
    save_job({"work_date": start.isoformat(), "items": {"Installation": 1}})

    invoice = build_mercury_invoice(start, end)
    due = datetime.strptime(invoice["due_date"], "%m/%d/%y").date()
    assert due.weekday() == 4
    assert (due - end).days == 13


def test_reports_bills_the_week_that_just_closed(client, ctx):
    """On any day of the current week, the invoice covers the previous one."""
    from mercury.models import last_completed_week
    start, end = last_completed_week()
    save_job({"work_date": start.isoformat(), "address": "Closed week",
              "items": {"Installation": 1}})
    save_job({"work_date": week_bounds()[0].isoformat(), "address": "In progress",
              "items": {"Installation": 9}})

    body = client.get("/reports").data.decode()
    assert start.strftime("%b %d") in body
    # The in-progress week's larger total must not be what is offered to bill.
    assert "$990.00" not in body


def test_exports_download_as_real_workbooks(client, ctx):
    start, _ = week_bounds()
    save_job({"work_date": start.isoformat(), "address": "A",
              "items": {"Installation": 1}})

    for kind in ("contractor", "personal"):
        response = client.get(f"/api/export/{kind}")
        assert response.status_code == 200
        assert response.data[:2] == b"PK"          # xlsx is a zip
        assert len(response.data) > 4000


def test_contractor_sheet_hides_pay_but_personal_shows_it(client, ctx):
    import io
    import openpyxl
    start, _ = week_bounds()
    save_job({"work_date": start.isoformat(), "address": "A",
              "items": {"Installation": 1}})

    contractor = openpyxl.load_workbook(
        io.BytesIO(client.get("/api/export/contractor").data)).active
    personal = openpyxl.load_workbook(
        io.BytesIO(client.get("/api/export/personal").data)).active

    contractor_headers = [c.value for c in contractor[5]]
    personal_headers = [c.value for c in personal[5]]
    assert "Job Total" not in contractor_headers
    assert "Job Total" in personal_headers


def test_deleting_a_job_removes_it_from_the_week(client, ctx):
    start, end = week_bounds()
    job = save_job({"work_date": start.isoformat(), "items": {"Installation": 1}})
    assert week_summary(start, end)["job_count"] == 1

    assert client.delete(f"/api/jobs/{job['id']}").get_json()["ok"] is True
    assert week_summary(start, end)["job_count"] == 0


def test_quote_prices_without_saving(client, ctx):
    start, end = week_bounds()
    result = client.post("/api/quote", json={"items": {"Installation": 2}}).get_json()
    assert result["total"] == pytest.approx(220.0)
    assert week_summary(start, end)["job_count"] == 0


def test_email_fails_loudly_when_unconfigured(client, ctx):
    start, _ = week_bounds()
    save_job({"work_date": start.isoformat(), "items": {"Installation": 1}})
    response = client.post("/api/email/personal")
    assert response.status_code == 400
    assert "not configured" in response.get_json()["error"].lower()


def test_gemini_model_is_env_driven_not_hardcoded():
    """Model names turn over; changing one must not need a code edit.

    Run in a subprocess: Config resolves the environment at import, and
    reloading it in-process would hand other modules a stale Config class.
    """
    import json
    import os
    import subprocess
    import sys

    from mercury.config import BASE_DIR

    result = subprocess.run(
        [sys.executable, "-c",
         "import json;from mercury.config import Config;"
         "print(json.dumps([Config.GEMINI_MODEL, Config.GEMINI_MAX_OUTPUT_TOKENS]))"],
        cwd=BASE_DIR,
        env={**os.environ, "GEMINI_MODEL": "gemini-9.9-flash",
             "GEMINI_MAX_OUTPUT_TOKENS": "4096", "PYTHONPATH": str(BASE_DIR)},
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    model, max_tokens = json.loads(result.stdout.strip().splitlines()[-1])
    assert model == "gemini-9.9-flash"
    assert max_tokens == 4096


def test_ai_stays_off_without_a_key(client, ctx):
    """No key means the scanner falls back to OCR rather than erroring oddly."""
    from mercury import ai
    assert ai.available() is False

    response = client.get("/api/ai/models")
    assert response.status_code == 400
    assert "GEMINI_API_KEY" in response.get_json()["error"]

    with pytest.raises(ai.AIUnavailable, match="GEMINI_API_KEY"):
        ai.parse_equipment_images([])


def test_scan_endpoint_tells_the_client_to_fall_back(client, ctx):
    """A 503 with fallback:'offline' is what makes the browser switch to OCR."""
    import io
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(buffer, format="PNG")
    buffer.seek(0)

    response = client.post("/api/parse-equipment",
                           data={"images": (buffer, "label.png")},
                           content_type="multipart/form-data")
    assert response.status_code == 503
    assert response.get_json()["fallback"] == "offline"


def test_a_broken_ai_sdk_does_not_take_down_the_app(client, ctx, monkeypatch):
    """AI is an optional extra. A half-broken install of it must not stop
    someone logging a job — including when it fails with something that is
    not an Exception, as pyo3's PanicException does."""
    import builtins

    from mercury import ai
    from mercury.config import Config

    class Panic(BaseException):
        """Stand-in for pyo3's PanicException (BaseException, not Exception)."""

    real_import = builtins.__import__

    def exploding_import(name, *args, **kwargs):
        if name.startswith("google"):
            raise Panic("native extension failed to load")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", exploding_import)
    monkeypatch.setattr(Config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(ai, "_probed", False)
    monkeypatch.setattr(ai, "_sdk", None)
    monkeypatch.setattr(ai, "_sdk_error", None)

    assert ai.available() is False
    assert "failed to load" in (ai.load_error() or "")

    # The parts that matter in the field keep working, and Settings explains why.
    assert client.get("/").status_code == 200
    assert client.get("/jobs/new").status_code == 200
    assert client.get("/scanner").status_code == 200
    assert b"failed to load" in client.get("/settings").data


def test_the_ai_probe_runs_once_not_per_page(ctx, monkeypatch):
    """It is called from the template context on every render."""
    import builtins

    from mercury import ai
    from mercury.config import Config

    calls = []
    real_import = builtins.__import__

    def counting_import(name, *args, **kwargs):
        if name.startswith("google"):
            calls.append(name)
            raise ImportError("not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", counting_import)
    monkeypatch.setattr(Config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(ai, "_probed", False)
    monkeypatch.setattr(ai, "_sdk", None)
    monkeypatch.setattr(ai, "_sdk_error", None)

    for _ in range(5):
        ai.available()
    assert len(calls) == 1


def test_service_worker_is_stamped_with_a_real_build_id(client):
    """A hardcoded placeholder shipping to a phone would break caching."""
    body = client.get("/sw.js").data.decode()
    assert "__MERCURY_BUILD__" not in body

    match = re.search(r"const VERSION = '([^']+)'", body)
    assert match, "no VERSION in the served service worker"
    assert re.fullmatch(r"v[0-9a-f]{12}", match.group(1)), match.group(1)


def test_build_id_changes_when_a_cached_asset_changes(tmp_path):
    """The whole point: a changed stylesheet must retire the old caches.

    Without this, an installed phone serves stale JavaScript forever — which
    for this app means stale pay calculations.
    """
    from mercury.build import compute_build_id

    (tmp_path / "static" / "css").mkdir(parents=True)
    (tmp_path / "templates").mkdir()
    stylesheet = tmp_path / "static" / "css" / "app.css"
    stylesheet.write_text("body { color: red }")
    (tmp_path / "templates" / "base.html").write_text("<p>hello</p>")

    before = compute_build_id(tmp_path)
    assert compute_build_id(tmp_path) == before          # stable when nothing moves

    stylesheet.write_text("body { color: blue }")
    assert compute_build_id(tmp_path) != before          # and changes when it does


def test_build_id_covers_templates_and_new_files(tmp_path):
    from mercury.build import compute_build_id

    (tmp_path / "static").mkdir()
    (tmp_path / "templates").mkdir()
    page = tmp_path / "templates" / "page.html"
    page.write_text("<p>one</p>")
    before = compute_build_id(tmp_path)

    page.write_text("<p>two</p>")
    assert compute_build_id(tmp_path) != before

    after_edit = compute_build_id(tmp_path)
    (tmp_path / "static" / "extra.js").write_text("//")
    assert compute_build_id(tmp_path) != after_edit


def test_large_vendor_files_are_fingerprinted_by_size_not_read(tmp_path):
    """Hashing the ~10 MB OCR engine on every boot would cost more than it
    detects, so oversized files contribute their size instead."""
    from mercury.build import CONTENT_HASH_LIMIT, compute_build_id

    (tmp_path / "static" / "vendor").mkdir(parents=True)
    (tmp_path / "templates").mkdir()
    blob = tmp_path / "static" / "vendor" / "engine.wasm"

    blob.write_bytes(b"a" * (CONTENT_HASH_LIMIT + 10))
    before = compute_build_id(tmp_path)

    blob.write_bytes(b"b" * (CONTENT_HASH_LIMIT + 10))   # same size, new content
    assert compute_build_id(tmp_path) == before

    blob.write_bytes(b"c" * (CONTENT_HASH_LIMIT + 99))   # different size
    assert compute_build_id(tmp_path) != before
