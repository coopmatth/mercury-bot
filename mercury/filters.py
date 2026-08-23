"""Jinja filters and globals shared by every template."""
from __future__ import annotations

from datetime import datetime

from .config import Config
from .rates import ITEM_LIST, FOOTAGE_ITEMS, rate_label


def money(value) -> str:
    try:
        return f"${float(value):,.2f}"
    except (TypeError, ValueError):
        return "$0.00"


def qty(value) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "0"
    return str(int(number)) if number.is_integer() else f"{number:g}"


def nice_date(value, fmt: str = "%a %b %d") -> str:
    if not value:
        return ""
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").strftime(fmt)
    except ValueError:
        return str(value)


def register_filters(app) -> None:
    app.jinja_env.filters["money"] = money
    app.jinja_env.filters["qty"] = qty
    app.jinja_env.filters["nice_date"] = nice_date
    app.jinja_env.globals.update(
        ITEM_LIST=ITEM_LIST,
        FOOTAGE_ITEMS=FOOTAGE_ITEMS,
        rate_label=rate_label,
        TECH_NAME=Config.TECH_NAME,
        now=datetime.now,
    )
