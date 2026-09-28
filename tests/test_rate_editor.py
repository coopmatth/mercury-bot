"""The rate-card editor added in the GitHub restructure saved to a `rates`
table that was never created, so every save 500'd. These tests pin the fix:
the table exists and is seeded, saving actually persists, and rows can be
managed without breaking job pricing."""
import pytest


def test_rates_table_is_seeded_on_init(ctx):
    from mercury.rates import rate_table
    rows = rate_table()
    assert len(rows) == 9
    assert {r["item"] for r in rows} == {
        "R1 – Residential Installation", "D8 – Drop Splice (Terminal & NID)",
        "D7 – Place NID Housing w/ Riser", "D11 – UG Temp Drop",
        "D6 – Pull Through Existing Conduit", "D5 – Sidewalk Bore",
        "D10 – Truck Roll / Trip Fee", "A1 – Hang Overhead Drop",
        "D2 – Direct Bury Flat Drop",
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
    install = next(r for r in rates if r["item"] == "R1 – Residential Installation")

    response = client.post("/api/rates", json={
        "id": install["id"], "name": "R1 – Residential Installation", "rate": 75, "unit": "ea",
    })
    assert response.status_code == 200

    updated = client.get("/api/rates").get_json()["rates"]
    assert next(r["rate"] for r in updated if r["item"] == "R1 – Residential Installation") == 75


def test_saving_a_rate_without_a_name_is_rejected(client):
    response = client.post("/api/rates", json={"rate": 10})
    assert response.status_code == 400
    assert response.get_json()["ok"] is False


def test_deleting_a_rate_removes_it_from_the_item_list(client, ctx):
    from mercury.rates import get_item_list

    rates = client.get("/api/rates").get_json()["rates"]
    bore = next(r for r in rates if r["item"] == "D5 – Sidewalk Bore")

    response = client.delete(f"/api/rates/{bore['id']}")
    assert response.status_code == 200
    assert response.get_json()["ok"] is True

    assert "D5 – Sidewalk Bore" not in get_item_list()


def test_deleting_an_ordinary_rate_succeeds(client):
    rates = client.get("/api/rates").get_json()["rates"]
    trip_fee = next(r for r in rates if r["item"] == "D10 – Truck Roll / Trip Fee")

    response = client.delete(f"/api/rates/{trip_fee['id']}")
    assert response.status_code == 200

    remaining = client.get("/api/rates").get_json()["rates"]
    assert not any(r["item"] == "D10 – Truck Roll / Trip Fee" for r in remaining)


def test_deleting_an_unknown_id_returns_400_not_a_crash(client):
    response = client.delete("/api/rates/does-not-exist")
    assert response.status_code == 400


def test_a_job_still_prices_footage_correctly_after_editing_rates(client, ctx):
    """The rate editor is backed by real data — confirm adding a row doesn't
    disturb the tiered aerial pricing."""
    from mercury.rates import calculate_job_total

    client.post("/api/rates", json={"name": "New Charge", "rate": 5, "unit": "ea"})
    assert calculate_job_total({"A1 – Hang Overhead Drop": 780}) == pytest.approx(240.0)
