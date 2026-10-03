"""The client prices jobs locally so the total is right with no signal, which
means the rate table exists twice. This test fails the moment they disagree."""
import re
from pathlib import Path

import pytest

from mercury.config import BASE_DIR
from mercury.rates import FOOTAGE_ITEMS, RATE_ALIASES, get_pay_rates

APP_JS = (BASE_DIR / "static" / "js" / "app.js").read_text()


def _js_rates() -> dict:
    # `let`, not `const`: the dynamic rate-loading code (loadDynamicRates in
    # app.js) mutates this object in place once the client fetches the live
    # rate card, so it can no longer be declared const.
    block = re.search(r"export let RATES = \{(.*?)\};", APP_JS, re.S)
    assert block, "RATES table not found in static/js/app.js"
    rates = {}
    for name, value in re.findall(r"""['"](.+?)['"]\s*:\s*(-?[\d.]+)""", block.group(1)):
        rates[name] = float(value)
    return rates


def _js_aliases() -> dict:
    block = re.search(r"export const RATE_ALIASES = \{(.*?)\};", APP_JS, re.S)
    assert block, "RATE_ALIASES not found in static/js/app.js"
    # Item names can contain apostrophes (e.g. "bore (0-12')"), so parse
    # line-by-line: the value runs to the last quote of its kind on the line.
    aliases = {}
    for line in block.group(1).splitlines():
        m = re.match(r"""\s*['"](.+?)['"]\s*:\s*(['"])(.*)\2\s*,?\s*$""", line)
        if m:
            aliases[m.group(1)] = m.group(3)
    return aliases


def _js_footage_items() -> set:
    block = re.search(r"export const FOOTAGE_ITEMS = new Set\(\[(.*?)\]\);", APP_JS, re.S)
    assert block, "FOOTAGE_ITEMS not found in static/js/app.js"
    return set(re.findall(r"""['"](.+?)['"]""", block.group(1)))


def test_flat_rates_match_the_server():
    # PAY_RATES is a proxy whose real dict protocol (iteration, equality,
    # dict()) is not implemented — only __getitem__/.get()/__contains__ are,
    # so comparisons go through the underlying get_pay_rates() directly.
    assert _js_rates() == get_pay_rates()


def test_aliases_match_the_server():
    """Old card names must resolve identically on both sides, or an old job
    prices differently offline than it does on the server."""
    assert _js_aliases() == RATE_ALIASES


def test_footage_items_match_the_server():
    assert _js_footage_items() == FOOTAGE_ITEMS
