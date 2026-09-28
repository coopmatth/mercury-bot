"""Pay rates and job-total math with dynamic rate card support."""
from __future__ import annotations

from .db import get_db, new_id

# Bumped whenever the official rate card changes. init_db() replaces the
# `rates` table wholesale when the stored version doesn't match, so a
# `git pull` + restart is all it takes to roll a new card out to every
# install — including ones already seeded with an older card.
RATE_CARD_VERSION = "2026-09-28-revert-old-names"

# Full restore of the pre-2026-09-27 card: the new rates were postponed and
# the user wanted the original line-item names back as well. Names, prices,
# units, display order, and tiered aerial pricing are all back to exactly
# how they were.
# (name, rate, unit, is_tiered, sort_order).
AERIAL_ITEM = "Aerial Drop Footage"
AERIAL_TIER_1_MAX = 300
AERIAL_TIER_2_MAX = 600
AERIAL_TIER_3_MIN = 601
AERIAL_TIER_1_PRICE = 75.00
AERIAL_TIER_2_PRICE = 150.00
AERIAL_OVERAGE_RATE = 0.50

NEW_RATE_CARD: list[tuple[str, float, str, int, int]] = [
    ("Installation", 110.00, "ea", 0, 1),
    ("Fusion Splice", 15.00, "ea", 0, 2),
    ("Place Nid w/ Riser", 12.50, "ea", 0, 3),
    ("Temp drop laid", 20.00, "ea", 0, 4),
    ("Trip Fee", 30.00, "ea", 0, 5),
    ("Direct bury flat drop (0-300')", 75.00, "ea", 0, 6),
    ("bore (0-12')", 25.00, "ea", 0, 7),
    ("Conduit Pull Footage", 0.55, "ft", 0, 8),
    ("Aerial Drop Footage", 0.00, "ft", 1, 9),
]

# 2026-09-27 card names -> restored original names. Jobs saved while the new
# card was live carry the new names in their `items` JSON; resolving them
# here (and in normalize_items) keeps every existing job priced instead of
# silently dropping to $0.
RATE_ALIASES: dict[str, str] = {
    "R1 – Residential Installation": "Installation",
    "D8 – Drop Splice (Terminal & NID)": "Fusion Splice",
    "D7 – Place NID Housing w/ Riser": "Place Nid w/ Riser",
    "D11 – UG Temp Drop": "Temp drop laid",
    "D10 – Truck Roll / Trip Fee": "Trip Fee",
    "D2 – Direct Bury Flat Drop": "Direct bury flat drop (0-300')",
    "D5 – Sidewalk Bore": "bore (0-12')",
    "D6 – Pull Through Existing Conduit": "Conduit Pull Footage",
    "A1 – Hang Overhead Drop": "Aerial Drop Footage",
}

# Fallback default items
DEFAULT_ITEM_LIST = [name for name, _rate, _unit, _tiered, _order in NEW_RATE_CARD]

FOOTAGE_ITEMS = {
    name for name, _rate, unit, _tiered, _order in NEW_RATE_CARD if unit == "ft"
}


def aerial_drop_price(feet: float) -> float:
    if feet <= 0:
        return 0.0
    if feet <= AERIAL_TIER_1_MAX:
        return AERIAL_TIER_1_PRICE
    if feet <= AERIAL_TIER_2_MAX:
        return AERIAL_TIER_2_PRICE
    return round(AERIAL_TIER_2_PRICE + (feet - AERIAL_TIER_2_MAX) * AERIAL_OVERAGE_RATE, 2)


def aerial_tier(feet: float) -> str:
    if feet <= AERIAL_TIER_1_MAX:
        return "0-300"
    if feet <= AERIAL_TIER_2_MAX:
        return "301-600"
    return "601+"


def resolve_name(item_name: str) -> str:
    """Map a pre-card-swap item name to its current name. Unknown names
    pass through unchanged."""
    return RATE_ALIASES.get(item_name, item_name)


def get_all_rates() -> list[dict]:
    try:
        rows = get_db().execute("SELECT * FROM rates ORDER BY sort_order ASC, name ASC").fetchall()
        if rows:
            return [dict(r) for r in rows]
    except Exception:
        pass
    return [
        {"id": str(i), "name": name, "rate": rate, "unit": unit,
         "is_tiered": tiered, "sort_order": order}
        for i, (name, rate, unit, tiered, order) in enumerate(NEW_RATE_CARD, start=1)
    ]


def get_item_list() -> list[str]:
    rates = get_all_rates()
    return [r["name"] for r in rates]


# Dynamic reference proxy for backwards-compatibility
class _ItemListProxy(list):
    def __iter__(self):
        return iter(get_item_list())
    def __len__(self):
        return len(get_item_list())
    def __contains__(self, item):
        return item in get_item_list()
    def __getitem__(self, index):
        return get_item_list()[index]

ITEM_LIST = _ItemListProxy(DEFAULT_ITEM_LIST)


def get_pay_rates() -> dict[str, float]:
    return {r["name"]: float(r["rate"]) for r in get_all_rates()}


# Dynamic dictionary proxy for PAY_RATES
class _PayRatesProxy(dict):
    def __getitem__(self, key):
        return get_pay_rates().get(key, 0.0)
    def get(self, key, default=0.0):
        return get_pay_rates().get(key, default)
    def __contains__(self, key):
        return key in get_pay_rates()

PAY_RATES = _PayRatesProxy()


def item_price(item_name: str, qty: float) -> float:
    if not item_name or qty is None or qty <= 0:
        return 0.0
    if resolve_name(item_name) == AERIAL_ITEM:
        return aerial_drop_price(qty)
    pay_rates = get_pay_rates()
    return round(qty * pay_rates.get(resolve_name(item_name), 0.0), 2)


def calculate_job_total(item_quantities: dict) -> float:
    return round(sum(item_price(name, qty or 0) for name, qty in (item_quantities or {}).items()), 2)


def rate_label(item_name: str) -> str:
    name = resolve_name(item_name)
    if name == AERIAL_ITEM:
        return "$75 / $150 / +$0.50 ft"
    rates = {r["name"]: r for r in get_all_rates()}
    info = rates.get(name)
    if not info:
        return "$0.00 ea"
    unit = " / ft" if info["unit"] == "ft" else " ea"
    return f"${info['rate']:,.2f}{unit}"


def rate_table() -> list[dict]:
    return [
        {
            "id": r["id"],
            "item": r["name"],
            "rate": r["rate"],
            "tiered": bool(r["is_tiered"]),
            "unit": r["unit"],
            "label": rate_label(r["name"]),
        }
        for r in get_all_rates()
    ]


def save_rate_card_item(name: str, rate: float, unit: str = "ea", item_id: str = "") -> None:
    conn = get_db()
    with conn:
        if item_id:
            conn.execute(
                "UPDATE rates SET name = ?, rate = ?, unit = ? WHERE id = ?",
                (name, rate, unit, item_id),
            )
        else:
            conn.execute(
                "INSERT OR REPLACE INTO rates (id, name, rate, unit, is_tiered, sort_order) VALUES (?, ?, ?, ?, 0, 99)",
                (new_id(), name, rate, unit),
            )


def delete_rate_card_item(item_id: str) -> bool:
    """Delete a rate card row. Returns False when the row doesn't exist."""
    conn = get_db()
    row = conn.execute("SELECT id FROM rates WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        return False
    with conn:
        conn.execute("DELETE FROM rates WHERE id = ?", (item_id,))
    return True
