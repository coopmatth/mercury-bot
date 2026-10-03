"""The pay math is the part that must never silently drift."""
import pytest

from mercury.rates import (FOOTAGE_ITEMS, NEW_RATE_CARD, RATE_ALIASES,
                           RATE_CARD_VERSION, calculate_job_total, item_price,
                           rate_label, rate_table, resolve_name, ITEM_LIST,
                           PAY_RATES)


def test_card_has_19_items_and_nothing_tiered():
    assert len(NEW_RATE_CARD) == 19
    assert len(rate_table()) == 19
    assert not any(r["tiered"] for r in rate_table())


def test_rate_card_version_is_stamped():
    assert RATE_CARD_VERSION == "2026-10-03-sub-inhome"


def test_flat_rates_multiply():
    assert item_price("Installation", 3) == pytest.approx(210.0)
    assert item_price("Conduit Pull Footage", 180) == pytest.approx(90.0)
    assert item_price("TC1 – Service/Repair Call", 2) == pytest.approx(75.0)


def test_per_foot_items_are_linear():
    # The old tiered aerial pricing is gone: aerial is a flat $0.40/ft.
    assert item_price("Aerial Drop Footage", 780) == pytest.approx(312.0)
    assert item_price("Aerial Drop Footage", 1) == pytest.approx(0.4)
    assert item_price("Direct bury flat drop (0-300')", 100) == pytest.approx(60.0)
    assert item_price("RA1 – Replace Hang Overhead Drop", 50) == pytest.approx(20.0)


def test_chargeback_is_negative():
    assert item_price("Chargeback (Tech Error)", 1) == pytest.approx(-50.0)
    assert item_price("Chargeback (Tech Error)", 2) == pytest.approx(-100.0)


def test_unknown_and_nonpositive_items_are_free():
    assert item_price("Nonsense", 5) == 0.0
    assert item_price("Installation", 0) == 0.0
    assert item_price("Installation", -2) == 0.0
    assert item_price("", 3) == 0.0


def test_new_card_names_resolve_to_current_rates():
    # Jobs saved while the 2026-09-27 card (new names) was live keep pricing
    # at the current card instead of dropping to $0.
    assert resolve_name("A1 – Hang Overhead Drop") == "Aerial Drop Footage"
    assert resolve_name("R1 – Residential Installation") == "Installation"
    assert resolve_name("D6 – Pull Through Existing Conduit") == "Conduit Pull Footage"
    assert resolve_name("D5 – Sidewalk Bore") == "bore (0-12')"
    assert resolve_name("Something New") == "Something New"  # passthrough

    assert item_price("A1 – Hang Overhead Drop", 100) == pytest.approx(40.0)
    assert item_price("R1 – Residential Installation", 2) == pytest.approx(140.0)
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
        "Direct bury flat drop (0-300')",
        "Conduit Pull Footage",
        "RA1 – Replace Hang Overhead Drop",
        "RD1 – Replace Direct Bury Flat Drop",
    }


def test_rate_labels():
    assert rate_label("Aerial Drop Footage") == "$0.40 / ft"
    assert rate_label("Installation") == "$70.00 ea"
    assert rate_label("Chargeback (Tech Error)") == "$-50.00 ea"
    assert rate_label("A1 – Hang Overhead Drop") == "$0.40 / ft"  # via alias
    assert rate_label("Nonsense") == "$0.00 ea"


def test_job_total_sums_lines():
    total = calculate_job_total({
        "Installation": 1,                # 70.00
        "Aerial Drop Footage": 250,       # 100.00
        "Chargeback (Tech Error)": 1,     # -50.00
    })
    assert total == pytest.approx(120.0)
