"""Pay rates and job-total math.

This module is the money. Everything else in the app renders, stores or
transmits what these functions produce, so the rates and the tier
boundaries below are carried over from the original tracker unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

# Order matters: it is the column order of every exported spreadsheet and the
# field order of the job form.
ITEM_LIST = [
    "Installation",
    "Fusion Splice",
    "Place Nid w/ Riser",
    "Temp drop laid",
    "Trip Fee",
    "Direct bury flat drop (0-300')",
    "bore (0-12')",
    "Conduit Pull Footage",
    "Aerial Drop Footage",
]

# Flat per-unit rates. "Aerial Drop Footage" is deliberately absent: it is
# tiered, not linear, and is priced by aerial_drop_price() below.
PAY_RATES = {
    "Installation": 110.00,
    "Fusion Splice": 15.00,
    "Place Nid w/ Riser": 12.50,
    "Temp drop laid": 20.00,
    "Trip Fee": 30.00,
    "Direct bury flat drop (0-300')": 75.00,
    "bore (0-12')": 25.00,
    "Conduit Pull Footage": 0.55,
}

AERIAL_ITEM = "Aerial Drop Footage"

# Items measured in feet rather than whole units. The UI labels these "ft" and
# allows decimals; everything else steps by 1.
FOOTAGE_ITEMS = {"Conduit Pull Footage", AERIAL_ITEM}

AERIAL_TIER_1_MAX = 300      # 0-300 ft  -> flat
AERIAL_TIER_2_MAX = 600      # 301-600 ft -> flat
AERIAL_TIER_1_PRICE = 75.00
AERIAL_TIER_2_PRICE = 150.00
AERIAL_OVERAGE_RATE = 0.50   # per foot beyond 600


@dataclass(frozen=True)
class LineItem:
    """One priced row on an invoice."""
    description: str
    qty: float
    rate: float
    amount: float

    def to_dict(self) -> dict:
        return asdict(self)


def aerial_drop_price(feet: float) -> float:
    """Price a single aerial drop of `feet` feet.

    Tiered, not linear: flat to 300 ft, flat again to 600 ft, then the
    tier-2 price plus a per-foot overage.
    """
    if feet <= 0:
        return 0.0
    if feet <= AERIAL_TIER_1_MAX:
        return AERIAL_TIER_1_PRICE
    if feet <= AERIAL_TIER_2_MAX:
        return AERIAL_TIER_2_PRICE
    return AERIAL_TIER_2_PRICE + (feet - AERIAL_TIER_2_MAX) * AERIAL_OVERAGE_RATE


def aerial_tier(feet: float) -> str:
    """Tier label used to group aerial drops on an invoice."""
    if feet <= AERIAL_TIER_1_MAX:
        return "0-300"
    if feet <= AERIAL_TIER_2_MAX:
        return "301-600"
    return "601+"


def item_price(item_name: str, qty: float) -> float:
    """Price `qty` of a single line item."""
    if item_name not in ITEM_LIST or qty is None or qty <= 0:
        return 0.0
    if item_name == AERIAL_ITEM:
        return aerial_drop_price(qty)
    return qty * PAY_RATES.get(item_name, 0.0)


def calculate_job_total(item_quantities: dict) -> float:
    """Total pay for one job, given {item name: quantity}."""
    return round(sum(item_price(name, qty or 0) for name, qty in item_quantities.items()), 2)


def rate_label(item_name: str) -> str:
    """Human-readable rate, for the job form and rate sheet."""
    if item_name == AERIAL_ITEM:
        return "$75 / $150 / +$0.50 ft"
    rate = PAY_RATES.get(item_name, 0.0)
    unit = " / ft" if item_name in FOOTAGE_ITEMS else " ea"
    return f"${rate:,.2f}{unit}"


def rate_table() -> list[dict]:
    """The full rate card, for the API and the in-app rate sheet."""
    return [
        {
            "item": name,
            "rate": PAY_RATES.get(name),
            "tiered": name == AERIAL_ITEM,
            "unit": "ft" if name in FOOTAGE_ITEMS else "ea",
            "label": rate_label(name),
        }
        for name in ITEM_LIST
    ]
