"""The pay math is the part that must never silently drift."""
import pytest

from mercury.rates import (FOOTAGE_ITEMS, NEW_RATE_CARD, RATE_ALIASES,
                           RATE_CARD_VERSION, aerial_drop_price, aerial_tier,
                           calculate_job_total, item_price, rate_label,
                           rate_table, resolve_name, ITEM_LIST, PAY_RATES)


def test_card_has_9_items_with_tiered_aerial():
    assert len(NEW_RATE_CARD) == 9
    assert len(rate_table()) == 9
    tiered = [r for r in rate_table() if r["tiered"]]
    assert [r["item"] for r in tiered] == ["Aerial Drop Footage"]


def test_rate_card_version_is_stamped():
    assert RATE_CARD_VERSION == "2026-09-28-revert-old-names"


@pytest.mark.parametrize("feet,expected", [
    (0, 0.0),
    (1, 75.0),
    (300, 75.0),        # top of tier 1
    (301, 150.0),       # bottom of tier 2
    (600, 150.0),       # top of tier 2
    (601, 150.5),       # first overage foot
    (602, 151.0),
    (700, 200.0),
    (780, 240.0),
    (1000, 350.0),
])
def test_aerial_is_tiered_not_linear(feet, expected):
    assert aerial_drop_price(feet) == pytest.approx(expected)


def test_aerial_tier_labels():
    assert aerial_tier(300) == "0-300"
    assert aerial_tier(301) == "301-600"
    assert aerial_tier(601) == "601+"


def test_flat_rates_multiply():
    assert item_price("Installation", 3) == pytest.approx(330.0)
    assert item_price("Conduit Pull Footage", 180) == pytest.approx(99.0)
    assert item_price("Direct bury flat drop (0-300')", 2) == pytest.approx(150.0)
    assert item_price("Trip Fee", 1) == pytest.approx(30.0)


def test_unknown_and_nonpositive_items_are_free():
    assert item_price("Nonsense", 5) == 0.0
    assert item_price("Installation", 0) == 0.0
    assert item_price("Installation", -2) == 0.0
    assert item_price("", 3) == 0.0


def test_new_card_names_resolve_to_restored_rates():
    # Jobs saved while the 2026-09-27 card was live keep pricing at the
    # restored card instead of dropping to $0.
    assert resolve_name("A1 – Hang Overhead Drop") == "Aerial Drop Footage"
    assert resolve_name("R1 – Residential Installation") == "Installation"
    assert resolve_name("D6 – Pull Through Existing Conduit") == "Conduit Pull Footage"
    assert resolve_name("D5 – Sidewalk Bore") == "bore (0-12')"
    assert resolve_name("Something New") == "Something New"  # passthrough

    assert item_price("A1 – Hang Overhead Drop", 100) == pytest.approx(75.0)
    assert item_price("A1 – Hang Overhead Drop", 700) == pytest.approx(200.0)
    assert item_price("R1 – Residential Installation", 2) == pytest.approx(220.0)
    assert item_price("D8 – Drop Splice (Terminal & NID)", 1) == pytest.approx(15.0)


def test_aliases_cover_every_retired_name():
    new_names = {
        "R1 – Residential Installation", "D8 – Drop Splice (Terminal & NID)",
        "D7 – Place NID Housing w/ Riser", "D11 – UG Temp Drop",
        "D10 – Truck Roll / Trip Fee", "D2 – Direct Bury Flat Drop",
        "D5 – Sidewalk Bore", "D6 – Pull Through Existing Conduit",
        "A1 – Hang Overhead Drop",
    }
    assert set(RATE_ALIASES) == new_names
    assert set(RATE_ALIASES.values()) <= set(ITEM_LIST)


def test_footage_items_are_the_ft_unit_rows():
    assert FOOTAGE_ITEMS == {
        "Aerial Drop Footage",
        "Conduit Pull Footage",
    }


def test_rate_labels():
    assert rate_label("Aerial Drop Footage") == "$75 / $150 / +$0.50 ft"
    assert rate_label("Installation") == "$110.00 ea"
    assert rate_label("Conduit Pull Footage") == "$0.55 / ft"
    assert rate_label("Direct bury flat drop (0-300')") == "$75.00 ea"
    assert rate_label("A1 – Hang Overhead Drop") == "$75 / $150 / +$0.50 ft"  # via alias
    assert rate_label("Nonsense") == "$0.00 ea"


def test_job_total_mixes_flat_and_tiered():
    total = calculate_job_total({
        "Installation": 2,            # 220.00
        "Fusion Splice": 3,           # 45.00
        "Aerial Drop Footage": 720,  # 150 + (720-600)*0.5 = 210.00
    })
    assert total == pytest.approx(475.0)
