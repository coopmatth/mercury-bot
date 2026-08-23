"""Sync has to survive the way the field actually works: no signal for hours,
a request that times out halfway, two devices editing the same job."""
from datetime import date

import pytest


def iso_today():
    return date.today().isoformat()


def push(client, device, since=0, **changes):
    response = client.post("/api/sync", json={
        "device_id": device, "since": since, "changes": changes,
    })
    assert response.status_code == 200
    return response.get_json()


def job(job_id, **overrides):
    base = {
        "id": job_id,
        "work_date": iso_today(),
        "address": "100 County Rd",
        "order_number": "A1",
        "items": {"Installation": 2},
        "created_at": "2026-08-23T09:00:00+00:00",
        "updated_at": "2026-08-23T09:00:00+00:00",
    }
    base.update(overrides)
    return base


def test_offline_queue_uploads_and_prices_correctly(client):
    result = push(client, "phone", jobs=[job("j1", items={
        "Installation": 2, "Aerial Drop Footage": 720})])
    assert result["applied"]["jobs"] == 1
    stored = client.get("/api/jobs").get_json()["jobs"][0]
    assert stored["total"] == pytest.approx(429.5)   # 220 + 209.50


def test_replaying_a_push_does_not_duplicate(client):
    """A request that times out gets retried; the server must absorb it."""
    payload = job("j1")
    push(client, "phone", jobs=[payload])
    push(client, "phone", jobs=[payload])
    push(client, "phone", jobs=[payload])
    assert len(client.get("/api/jobs").get_json()["jobs"]) == 1


def test_newest_edit_wins_regardless_of_arrival_order(client):
    push(client, "phone", jobs=[job("j1")])
    push(client, "tablet", jobs=[job("j1", address="corrected",
                                     updated_at="2026-08-23T18:00:00+00:00")])
    # The phone finally gets signal and pushes its stale copy.
    push(client, "phone", jobs=[job("j1", address="stale",
                                    updated_at="2026-08-23T09:00:00+00:00")])
    assert client.get("/api/jobs").get_json()["jobs"][0]["address"] == "corrected"


def test_deletes_propagate_as_tombstones(client):
    push(client, "phone", jobs=[job("j1")])
    push(client, "phone", jobs=[job("j1", deleted=1,
                                    updated_at="2026-08-23T19:00:00+00:00")])
    assert client.get("/api/jobs").get_json()["jobs"] == []

    pulled = push(client, "tablet", since=0)["changes"]["jobs"]
    assert [(r["id"], r["deleted"]) for r in pulled] == [("j1", 1)]


def test_delta_pull_returns_only_new_rows(client):
    push(client, "phone", jobs=[job("j1")])
    seq = push(client, "phone", jobs=[job("j2")])["server_seq"]
    push(client, "phone", jobs=[job("j3")])

    delta = push(client, "tablet", since=seq)["changes"]["jobs"]
    assert [r["id"] for r in delta] == ["j3"]


def test_one_bad_row_does_not_sink_the_batch(client):
    result = push(client, "phone", jobs=[job("good"), "not-a-dict", None])
    assert result["applied"]["jobs"] == 1
    assert len(client.get("/api/jobs").get_json()["jobs"]) == 1


def test_custom_items_round_trip_with_bill_to(client):
    push(client, "phone", custom_items=[{
        "id": "c1", "work_date": iso_today(), "name": "Pedestal repair",
        "qty": 2, "rate": 45, "bill_to": "remc",
    }])
    item = client.get("/api/custom-items").get_json()["custom_items"][0]
    assert item["total"] == pytest.approx(90.0)
    assert item["bill_to"] == "remc"


def test_devices_are_tracked(client):
    push(client, "phone-abc", jobs=[job("j1")])
    devices = client.get("/api/sync/status").get_json()["devices"]
    assert devices[0]["device_id"] == "phone-abc"
