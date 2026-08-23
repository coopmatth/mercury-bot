"""The rate-card editor added in the GitHub restructure saved to a `rates`
table that was never created, so every save 500'd. These tests pin the fix:
the table exists and is seeded, saving actually persists, and the tiered
aerial item can't be deleted out from under normalize_items()."""
import pytest


def test_rates_table_is_seeded_on_init(ctx):
    from mercury.rates import rate_table
    rows = rate_table()
    assert len(rows) == 9
    assert {r["item"] for r in rows} == {
        "Installation", "Fusion Splice", "Place Nid w/ Riser", "Temp drop laid",
        "Trip Fee", "Direct bury flat drop (0-300')", "bore (0-12')",
        "Conduit Pull Footage", "Aerial Drop Footage",
    }


def test_saving_a_new_rate_does_not_500(client):
    response = client.post("/api/rates", json={
        "name": "Splice Enclosure", "rate": 40, "unit": "ea",
    })
    assert response.status_code == 200
    data = response.get_json()
    assert data["ok"] is True

    listed = client.get("/api/rates").get_json()["rates"]
    assert any(r["item"] == "Splice Enclosure" and r["rate"] == 40 for r in listed)


def test_editing_an_existing_rate_persists(client):
    rates = client.get("/api/rates").get_json()["rates"]
    installation = next(r for r in rates if r["item"] == "Installation")

    response = client.post("/api/rates", json={
        "id": installation["id"], "name": "Installation", "rate": 125, "unit": "ea",
    })
    assert response.status_code == 200

    updated = client.get("/api/rates").get_json()["rates"]
    assert next(r["rate"] for r in updated if r["item"] == "Installation") == 125


def test_saving_a_rate_without_a_name_is_rejected(client):
    response = client.post("/api/rates", json={"rate": 10})
    assert response.status_code == 400
    assert response.get_json()["ok"] is False


def test_deleting_the_tiered_aerial_item_is_refused(client, ctx):
    from mercury.rates import get_item_list

    rates = client.get("/api/rates").get_json()["rates"]
    aerial = next(r for r in rates if r["tiered"])

    response = client.delete(f"/api/rates/{aerial['id']}")
    assert response.status_code == 400
    assert response.get_json()["ok"] is False

    # The whole point: deleting it would silently drop aerial footage out of
    # every job saved afterward, so it must still be a valid item.
    assert "Aerial Drop Footage" in get_item_list()


def test_deleting_an_ordinary_rate_succeeds(client):
    rates = client.get("/api/rates").get_json()["rates"]
    trip_fee = next(r for r in rates if r["item"] == "Trip Fee")

    response = client.delete(f"/api/rates/{trip_fee['id']}")
    assert response.status_code == 200

    remaining = client.get("/api/rates").get_json()["rates"]
    assert not any(r["item"] == "Trip Fee" for r in remaining)


def test_deleting_an_unknown_id_returns_400_not_a_crash(client):
    response = client.delete("/api/rates/does-not-exist")
    assert response.status_code == 400


def test_a_job_still_prices_aerial_footage_correctly_after_editing_rates(client, ctx):
    """The rate editor is now backed by real data — confirm it doesn't
    disturb the tiered pricing that isn't stored as a flat rate."""
    from mercury.rates import calculate_job_total

    client.post("/api/rates", json={"name": "New Charge", "rate": 5, "unit": "ea"})
    assert calculate_job_total({"Aerial Drop Footage": 780}) == pytest.approx(239.5)
