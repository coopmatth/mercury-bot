"""The pay math is the part that must never silently drift."""
import pytest

from mercury.rates import (aerial_drop_price, aerial_tier, calculate_job_total,
                           item_price, rate_table, ITEM_LIST, PAY_RATES)


@pytest.mark.parametrize("feet,expected", [
    (0, 0.0),
    (1, 75.0),
    (300, 75.0),        # top of tier 1
    (301, 150.0),       # bottom of tier 2
    (600, 150.0),       # top of tier 2
    (601, 150.0),       # tier 3 opens at the flat price, no overage yet
    (602, 150.5),       # first overage foot
    (700, 199.5),
    (780, 239.5),
    (1000, 349.5),
])
def test_aerial_is_tiered_not_linear(feet, expected):
    assert aerial_drop_price(feet) == pytest.approx(expected)


def test_aerial_tier_3_has_no_price_jump_at_the_boundary():
    """600 -> 601 must not cost the technician or the contractor a step."""
    assert aerial_drop_price(601) == aerial_drop_price(600) == 150.0


def test_aerial_overage_counts_from_601_not_600():
    from mercury.rates import AERIAL_OVERAGE_RATE, AERIAL_TIER_3_MIN
    assert AERIAL_TIER_3_MIN == 601
    for feet in (700, 850, 1200):
        expected = 150.0 + (feet - 601) * AERIAL_OVERAGE_RATE
        assert aerial_drop_price(feet) == pytest.approx(expected)


def test_aerial_tier_labels():
    assert aerial_tier(300) == "0-300"
    assert aerial_tier(301) == "301-600"
    assert aerial_tier(601) == "601+"


def test_flat_rates_multiply():
    assert item_price("Installation", 3) == pytest.approx(330.0)
    assert item_price("Conduit Pull Footage", 180) == pytest.approx(99.0)


def test_unknown_and_nonpositive_items_are_free():
    assert item_price("Nonsense", 5) == 0.0
    assert item_price("Installation", 0) == 0.0
    assert item_price("Installation", -2) == 0.0


def test_job_total_mixes_flat_and_tiered():
    total = calculate_job_total({
        "Installation": 2,          # 220
        "Fusion Splice": 3,         # 45
        "Aerial Drop Footage": 720, # 150 + (720-601)*0.5 = 209.50
    })
    assert total == pytest.approx(474.5)


def test_every_item_is_priceable():
    """Nothing in ITEM_LIST may fall through without a price."""
    for item in ITEM_LIST:
        assert item_price(item, 1) > 0, item


def test_rate_table_covers_the_item_list():
    assert [row["item"] for row in rate_table()] == ITEM_LIST
    aerial = [r for r in rate_table() if r["tiered"]]
    assert len(aerial) == 1 and aerial[0]["item"] == "Aerial Drop Footage"
    # Aerial's entry in the rate card carries a flat "rate" of 0 — it's a
    # placeholder for the tiered pricing table, never actually charged as a
    # flat rate. What has to hold is that item_price() still prices it
    # correctly despite that placeholder, not that it's absent from
    # PAY_RATES (it's a real row in the `rates` table now).
    assert PAY_RATES.get("Aerial Drop Footage", 0) == 0
    assert item_price("Aerial Drop Footage", 780) > 0
