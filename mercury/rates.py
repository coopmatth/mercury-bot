"""Pay rates and job-total math with dynamic rate card support."""
from __future__ import annotations

from .db import get_db, new_id

# Bumped whenever the official rate card changes. init_db() replaces the
# `rates` table wholesale when the stored version doesn't match, so a
# `git pull` + restart is all it takes to roll a new card out to every
# install — including ones already seeded with an older card.
RATE_CARD_VERSION = "2026-10-03-sub-inhome"

# The current subcontractor rate card (from sub_inhome.xlsx, 2026-09-27).
# (name, rate, unit, sort_order). Driveway bore codes D3/D4 are intentionally
# absent — they carry no sub rate. sort_order is the display order: the five
# most-used items first, then the rest of the card.
NEW_RATE_CARD: list[tuple[str, float, str, int]] = [
    ("R1 – Residential Installation", 70.00, "ea", 1),
    ("D8 – Drop Splice (Terminal & NID)", 15.00, "ea", 2),
    ("D7 – Place NID Housing w/ Riser", 20.00, "ea", 3),
    ("D11 – UG Temp Drop", 30.00, "ea", 4),
    ("D6 – Pull Through Existing Conduit", 0.50, "ft", 5),
    ("D5 – Sidewalk Bore", 25.00, "ea", 6),
    ("D10 – Truck Roll / Trip Fee", 25.00, "ea", 7),
    ("A1 – Hang Overhead Drop", 0.40, "ft", 8),
    ("D2 – Direct Bury Flat Drop", 0.60, "ft", 9),
    ("D9 – Install Flowerpot", 25.00, "ea", 10),
    ("TC1 – Service/Repair Call", 37.50, "ea", 11),
    ("RA1 – Replace Hang Overhead Drop", 0.40, "ft", 12),
    ("RD1 – Replace Direct Bury Flat Drop", 0.60, "ft", 13),
    ("RN1 – Replace NID", 20.00, "ea", 14),
    ("RS1 – Drop Splice (Repair)", 15.00, "ea", 15),
    ("W1 – Fixed Wireless Installation", 120.00, "ea", 16),
    ("W2 – Fixed Wireless Installation (Fail)", 50.00, "ea", 17),
    ("P1 – Post Placement", 30.00, "ea", 18),
    ("Chargeback (Tech Error)", -50.00, "ea", 19),
]

# Old card names -> current names. Jobs saved before the 2026-09-27 card
# swap still carry the old names in their `items` JSON; resolving them here
# (and in normalize_items) keeps every existing job priced at the new rates
# instead of silently dropping to $0. "bore (0-12')" maps to D5 at the same
# $25 it always paid — the driveway bore codes it replaced carry no sub rate.
RATE_ALIASES: dict[str, str] = {
    "Installation": "R1 – Residential Installation",
    "Fusion Splice": "D8 – Drop Splice (Terminal & NID)",
    "Place Nid w/ Riser": "D7 – Place NID Housing w/ Riser",
    "Temp drop laid": "D11 – UG Temp Drop",
    "Trip Fee": "D10 – Truck Roll / Trip Fee",
    "Direct bury flat drop (0-300')": "D2 – Direct Bury Flat Drop",
    "bore (0-12')": "D5 – Sidewalk Bore",
    "Conduit Pull Footage": "D6 – Pull Through Existing Conduit",
    "Aerial Drop Footage": "A1 – Hang Overhead Drop",
}

# Fallback default items
DEFAULT_ITEM_LIST = [name for name, _rate, _unit, _order in NEW_RATE_CARD]

FOOTAGE_ITEMS = {
    name for name, _rate, unit, _order in NEW_RATE_CARD if unit == "ft"
}


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
         "is_tiered": 0, "sort_order": order}
        for i, (name, rate, unit, order) in enumerate(NEW_RATE_CARD, start=1)
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
    pay_rates = get_pay_rates()
    return round(qty * pay_rates.get(resolve_name(item_name), 0.0), 2)


def calculate_job_total(item_quantities: dict) -> float:
    return round(sum(item_price(name, qty or 0) for name, qty in (item_quantities or {}).items()), 2)


def rate_label(item_name: str) -> str:
    name = resolve_name(item_name)
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
            "tiered": False,
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
