"""Route smoke tests, week math, and the export/invoice pipeline."""
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
              "items": {"Aerial Drop Footage": 700}})              # 200
    save_custom_item({"work_date": start.isoformat(), "name": "Extra",
                      "qty": 2, "rate": 45})                       # 90

    summary = week_summary(start, end)
    assert summary["jobs_total"] == pytest.approx(420.0)
    assert summary["custom_total"] == pytest.approx(90.0)
    assert summary["weekly"] == pytest.approx(510.0)
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

    # 780 ft = 150 + 180 * 0.50 = 240, on its own line.
    long_drop = next(v for k, v in by_desc.items() if "601'+" in k)
    assert long_drop["amount"] == pytest.approx(240.0)
    assert total == pytest.approx(540.0)


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


def test_due_date_is_the_second_friday_after_the_week_closes(ctx):
    from mercury.invoicing import default_due_date
    due = default_due_date(date(2026, 8, 29))   # a Saturday
    assert due.weekday() == 4                   # Friday
    assert due == date(2026, 9, 11)


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
