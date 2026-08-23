"""Demo-mode sample data.

Generates a couple of realistic pay weeks so every screen has something to
show: a dashboard with real numbers, jobs to open and edit, custom items on
both invoices, and a saved equipment scan.

Only ever touches the demo database — Config.DEMO must be on for any of this
to run, and demo mode points DB_PATH somewhere else entirely.
"""
from __future__ import annotations

import random
from datetime import date, timedelta

from .config import Config
from .db import get_db
from .models import (DATE_FMT, list_jobs, save_custom_item, save_job,
                     save_scan, week_start)

# Fictional addresses. Real-looking, deliberately not real.
ADDRESSES = [
    "1420 County Road 40", "885 N State Road 9", "3302 W Shadyside Road",
    "77 Lake View Drive", "9915 E 600 S", "204 Oak Hill Court",
    "6188 N Ridgeway Lane", "512 W Maple Street", "2740 S Township Line",
    "1109 Beechwood Trail", "8433 E Hollow Road", "355 Prairie Vista Way",
]

# Each entry is one plausible day's work.
JOB_PATTERNS = [
    {"Installation": 1, "Fusion Splice": 2, "Aerial Drop Footage": 420},
    {"Installation": 1, "Place Nid w/ Riser": 1, "bore (0-12')": 2},
    {"Installation": 2, "Conduit Pull Footage": 180},
    {"Installation": 1, "Temp drop laid": 1, "Trip Fee": 1},
    {"Installation": 1, "Direct bury flat drop (0-300')": 1, "Fusion Splice": 1},
    {"Installation": 1, "Aerial Drop Footage": 780},
    {"Installation": 1, "Fusion Splice": 1, "Aerial Drop Footage": 260},
    {"Trip Fee": 1},
    {"Installation": 2, "Fusion Splice": 3, "Place Nid w/ Riser": 2},
    {"Installation": 1, "Conduit Pull Footage": 95, "bore (0-12')": 1},
]

# Enough work in the current week that the dashboard has real numbers on it.
MIN_CURRENT_WEEK_JOBS = 6

NOTES = [
    "Aerial from pole 14.", "Customer not home on the first trip.",
    "Two units on one drop.", "Long run to the back of the property.",
    "Existing conduit reused.", "", "", "Dog on site — called ahead.", "",
]

SCAN_SAMPLE = """DROP= (AERIAL, HYBRID, NEEDS BURY)
ONT INFO
MAC = 4C1B86A2D004
MTA MAC = 4C1B86A2D005
FSAN = CXNK00A1B2C3
S/N = 202411004871
DB Levels/Light Levels = -18.4
Fiber Jumper Length = 15 ft
LCP = LCP-114
ROUTER INFO 
FSAN = CXNK00D4E5F6
MAC = 9C1A7B31C880
Provision speeds = 1G/1G
Actual Speeds = 940/920
Uploaded Pictures (Yes/No) = Yes
Rough NID Location = NE corner, behind meter"""


def _add_job(rng: random.Random, work_date: date) -> None:
    save_job({
        "work_date": work_date.strftime(DATE_FMT),
        "address": rng.choice(ADDRESSES),
        "order_number": str(rng.randint(4471000, 4479999)),
        "items": dict(rng.choice(JOB_PATTERNS)),
        "notes": rng.choice(NOTES),
    })


def is_seeded() -> bool:
    row = get_db().execute("SELECT COUNT(*) AS n FROM jobs").fetchone()
    return bool(row and row["n"])


def seed(weeks: int = 2, seed_value: int = 7) -> int:
    """Fill the demo database. Deterministic, so the demo looks the same
    every time it is reset."""
    if not Config.DEMO:
        raise RuntimeError("Refusing to seed sample data outside demo mode.")

    rng = random.Random(seed_value)
    today = date.today()
    created = 0

    for week_offset in range(weeks):
        start = week_start(today) - timedelta(days=7 * week_offset)
        # Only fill days that have actually happened.
        elapsed = [start + timedelta(days=d) for d in range(7)
                   if start + timedelta(days=d) <= today]

        for work_date in elapsed:
            for _ in range(rng.choice([0, 1, 2, 2, 3, 3, 4])):
                _add_job(rng, work_date)
                created += 1

        # Early in a week only a day or two has happened, which leaves the
        # dashboard looking empty on first open. Top the current week up so
        # the demo lands on something worth looking at.
        if week_offset == 0 and elapsed:
            existing = len(list_jobs(start, min(today, start + timedelta(days=6))))
            while existing < MIN_CURRENT_WEEK_JOBS:
                _add_job(rng, rng.choice(elapsed))
                existing += 1
                created += 1

        save_custom_item({
            "work_date": start.strftime(DATE_FMT),
            "name": "Extra wire run", "description": "Attic pull",
            "qty": 2, "rate": 45, "bill_to": "mercury",
        })
        save_custom_item({
            "work_date": (start + timedelta(days=2)).strftime(DATE_FMT),
            "name": "REMC pedestal repair", "description": "Storm damage",
            "qty": 1, "rate": 180, "bill_to": "remc",
        })

    save_scan({
        "address": "1420 County Road 40",
        "payload": SCAN_SAMPLE,
        "source": "ai",
    })
    return created


def reset() -> int:
    """Wipe the demo database back to freshly seeded sample data."""
    if not Config.DEMO:
        raise RuntimeError("Refusing to reset data outside demo mode.")

    conn = get_db()
    with conn:
        for table in ("jobs", "custom_items", "equipment_scans",
                      "invoices", "sync_devices"):
            conn.execute(f"DELETE FROM {table}")
        conn.execute("UPDATE meta SET value = '0' WHERE key = 'seq_counter'")

    for pdf in Config.EXPORT_DIR.glob("*.pdf"):
        pdf.unlink(missing_ok=True)
    for eml in Config.OUTBOX_DIR.glob("*.eml"):
        eml.unlink(missing_ok=True)

    return seed()


def seed_if_empty() -> None:
    if Config.DEMO and not is_seeded():
        seed()
