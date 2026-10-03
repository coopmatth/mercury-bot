"""The pay math is the part that must never silently drift."""
import pytest

from mercury.rates import (FOOTAGE_ITEMS, NEW_RATE_CARD, RATE_ALIASES,
                           RATE_CARD_VERSION, calculate_job_total, item_price,
                           rate_label, rate_table, resolve_name, ITEM_LIST,
                           PAY_RATES)


def test_card_has_9_items_and_nothing_tiered():
    assert len(NEW_RATE_CARD) == 9
    assert len(rate_table()) == 9
    assert not any(r["tiered"] for r in rate_table())


def test_rate_card_version_is_stamped():
    assert RATE_CARD_VERSION == "2026-10-03-sub-inhome-9"


def test_flat_rates_multiply():
    assert item_price("R1 – Residential Installation", 3) == pytest.approx(210.0)
    assert item_price("D6 – Pull Through Existing Conduit", 180) == pytest.approx(90.0)
    assert item_price("D10 – Truck Roll / Trip Fee", 2) == pytest.approx(50.0)


def test_per_foot_items_are_linear():
    # The old tiered aerial pricing is gone: A1 is a flat $0.40/ft.
    assert item_price("A1 – Hang Overhead Drop", 780) == pytest.approx(312.0)
    assert item_price("A1 – Hang Overhead Drop", 1) == pytest.approx(0.4)
    assert item_price("D2 – Direct Bury Flat Drop", 100) == pytest.approx(60.0)


def test_unknown_and_nonpositive_items_are_free():
    assert item_price("Nonsense", 5) == 0.0
    assert item_price("R1 – Residential Installation", 0) == 0.0
    assert item_price("R1 – Residential Installation", -2) == 0.0
    assert item_price("", 3) == 0.0


def test_old_card_names_resolve_to_new_rates():
    # Jobs saved before the 2026-09-27 card swap keep pricing at the new
    # rates instead of dropping to $0.
    assert resolve_name("Aerial Drop Footage") == "A1 – Hang Overhead Drop"
    assert resolve_name("Installation") == "R1 – Residential Installation"
    assert resolve_name("Conduit Pull Footage") == "D6 – Pull Through Existing Conduit"
    assert resolve_name("bore (0-12')") == "D5 – Sidewalk Bore"
    assert resolve_name("Something New") == "Something New"  # passthrough

    assert item_price("Aerial Drop Footage", 100) == pytest.approx(40.0)
    assert item_price("Installation", 2) == pytest.approx(140.0)
    assert item_price("Fusion Splice", 1) == pytest.approx(15.0)


def test_aliases_cover_every_old_name():
    old_names = {
        "Installation", "Fusion Splice", "Place Nid w/ Riser", "Temp drop laid",
        "Trip Fee", "Direct bury flat drop (0-300')", "bore (0-12')",
        "Conduit Pull Footage", "Aerial Drop Footage",
    }
    assert set(RATE_ALIASES) == old_names
    assert set(RATE_ALIASES.values()) <= set(ITEM_LIST)


def test_footage_items_are_the_ft_unit_rows():
    assert FOOTAGE_ITEMS == {
        "A1 – Hang Overhead Drop",
        "D2 – Direct Bury Flat Drop",
        "D6 – Pull Through Existing Conduit",
    }


def test_rate_labels():
    assert rate_label("A1 – Hang Overhead Drop") == "$0.40 / ft"
    assert rate_label("R1 – Residential Installation") == "$70.00 ea"
    assert rate_label("Aerial Drop Footage") == "$0.40 / ft"  # via alias
    assert rate_label("Nonsense") == "$0.00 ea"


def test_job_total_sums_lines():
    total = calculate_job_total({
        "R1 – Residential Installation": 1,   # 70.00
        "A1 – Hang Overhead Drop": 250,       # 100.00
        "Chargeback (Tech Error)": 1,         # -50.00
    })
    assert total == pytest.approx(170.0)
