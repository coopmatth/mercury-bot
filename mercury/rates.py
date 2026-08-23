"""Pay rates and job-total math with dynamic rate card support."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from .db import get_db, new_id

AERIAL_ITEM = "Aerial Drop Footage"
AERIAL_TIER_1_MAX = 300
AERIAL_TIER_2_MAX = 600
AERIAL_TIER_3_MIN = 601
AERIAL_TIER_1_PRICE = 75.00
AERIAL_TIER_2_PRICE = 150.00
AERIAL_OVERAGE_RATE = 0.50

# Fallback default items
DEFAULT_ITEM_LIST = [
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

FOOTAGE_ITEMS = {"Conduit Pull Footage", AERIAL_ITEM}


def get_all_rates() -> list[dict]:
    try:
        rows = get_db().execute("SELECT * FROM rates ORDER BY sort_order ASC, name ASC").fetchall()
        if rows:
            return [dict(r) for r in rows]
    except Exception:
        pass
    return [
        {"id": "1", "name": "Installation", "rate": 110.00, "unit": "ea", "is_tiered": 0, "sort_order": 1},
        {"id": "2", "name": "Fusion Splice", "rate": 15.00, "unit": "ea", "is_tiered": 0, "sort_order": 2},
        {"id": "3", "name": "Place Nid w/ Riser", "rate": 12.50, "unit": "ea", "is_tiered": 0, "sort_order": 3},
        {"id": "4", "name": "Temp drop laid", "rate": 20.00, "unit": "ea", "is_tiered": 0, "sort_order": 4},
        {"id": "5", "name": "Trip Fee", "rate": 30.00, "unit": "ea", "is_tiered": 0, "sort_order": 5},
        {"id": "6", "name": "Direct bury flat drop (0-300')", "rate": 75.00, "unit": "ea", "is_tiered": 0, "sort_order": 6},
        {"id": "7", "name": "bore (0-12')", "rate": 25.00, "unit": "ea", "is_tiered": 0, "sort_order": 7},
        {"id": "8", "name": "Conduit Pull Footage", "rate": 0.55, "unit": "ft", "is_tiered": 0, "sort_order": 8},
        {"id": "9", "name": "Aerial Drop Footage", "rate": 0.00, "unit": "ft", "is_tiered": 1, "sort_order": 9},
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


def aerial_drop_price(feet: float) -> float:
    if feet <= 0:
        return 0.0
    if feet <= AERIAL_TIER_1_MAX:
        return AERIAL_TIER_1_PRICE
    if feet <= AERIAL_TIER_2_MAX:
        return AERIAL_TIER_2_PRICE
    return round(AERIAL_TIER_2_PRICE + (feet - AERIAL_TIER_3_MIN) * AERIAL_OVERAGE_RATE, 2)


def aerial_tier(feet: float) -> str:
    if feet <= AERIAL_TIER_1_MAX:
        return "0-300"
    if feet <= AERIAL_TIER_2_MAX:
        return "301-600"
    return "601+"


def item_price(item_name: str, qty: float) -> float:
    if not item_name or qty is None or qty <= 0:
        return 0.0
    if item_name == AERIAL_ITEM:
        return aerial_drop_price(qty)
    pay_rates = get_pay_rates()
    return round(qty * pay_rates.get(item_name, 0.0), 2)


def calculate_job_total(item_quantities: dict) -> float:
    return round(sum(item_price(name, qty or 0) for name, qty in (item_quantities or {}).items()), 2)


def rate_label(item_name: str) -> str:
    if item_name == AERIAL_ITEM:
        return "$75 / $150 / +$0.50 ft"
    rates = {r["name"]: r for r in get_all_rates()}
    info = rates.get(item_name)
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


def delete_rate_card_item(item_id: str) -> None:
    conn = get_db()
    with conn:
        conn.execute("DELETE FROM rates WHERE id = ?", (item_id,))
