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
    (601, 150.5),       # first overage foot
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


def test_unknown_and_nonpositive_items_are_free():
    assert item_price("Nonsense", 5) == 0.0
    assert item_price("Installation", 0) == 0.0
    assert item_price("Installation", -2) == 0.0


def test_job_total_mixes_flat_and_tiered():
    total = calculate_job_total({
        "Installation": 2,          # 220
        "Fusion Splice": 3,         # 45
        "Aerial Drop Footage": 720, # 150 + 120*0.5 = 210
    })
    assert total == pytest.approx(475.0)


def test_every_item_is_priceable():
    """Nothing in ITEM_LIST may fall through without a price."""
    for item in ITEM_LIST:
        assert item_price(item, 1) > 0, item


def test_rate_table_covers_the_item_list():
    assert [row["item"] for row in rate_table()] == ITEM_LIST
    aerial = [r for r in rate_table() if r["tiered"]]
    assert len(aerial) == 1 and aerial[0]["item"] == "Aerial Drop Footage"
    assert "Aerial Drop Footage" not in PAY_RATES
