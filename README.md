# Mercury Tracker

Offline-first job tracking, pay and invoicing for fiber-optic field work.

Log a job on a ladder with no signal, get an invoice out of it on Friday. The
app is a phone-installable PWA backed by a small Flask + SQLite server you run
yourself — no accounts, no subscriptions, no cloud bill.

---

## What it does

| | |
|---|---|
| **Log jobs** | Tap-count rows for every line on the rate card, live pay total as you go |
| **Custom pay items** | One-off work outside the rate card, billable to Mercury or REMC |
| **Equipment scanner** | Reads ONT/gateway labels from photos — AI online, on-device OCR offline |
| **Photo compressor** | Shrinks job photos before upload, entirely on the phone |
| **Weekly spreadsheets** | Contractor sheet (quantities only) and pay sheet (with totals) |
| **Invoices** | Mercury and REMC PDFs on net-14 terms, emailed straight to the contractor |
| **Dashboard** | Today, this week, earnings by day, work completed, per-job averages |

### Everything works offline

Not "degrades gracefully" — works. Every screen is cached, every write lands in
IndexedDB first, and the pay math runs on the device, so the total you see with
no bars is the total that gets billed. A badge shows what's still queued; when
signal comes back it syncs itself.

The only things that genuinely need the network are generating a PDF, sending
an email, and the AI scanner — and the scanner falls back to on-device OCR
rather than failing.

---

## Setup

```bash
git clone <this repo> && cd mercury-bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env      # then edit it — see below
python run.py
```

Open `http://localhost:8080`. On a phone, open the machine's LAN address and
use **Add to Home Screen**; it installs as a standalone app.

### Configuration

All of it lives in `.env`, which is git-ignored. Nothing sensitive is committed,
stored in the browser, or sent anywhere except your own SMTP server.

| Variable | Notes |
|---|---|
| `SECRET_KEY` | Any long random string |
| `TECH_*` / `BILL_TO_*` | The from/to blocks on your invoices |
| `SENDER_EMAIL`, `EMAIL_PASSWORD` | Gmail requires a 16-character **App Password**, not your login |
| `CONTRACTOR_EMAIL`, `YOUR_EMAIL` | Where the two weekly reports go |
| `GEMINI_API_KEY` | Optional. Without it the scanner uses on-device OCR only |
| `MERCURY_DATA_DIR` | Where the database and exports live (default `./data`) |

### Running it for real

The Flask dev server is fine for one person on a laptop. For a box that stays
on, use the bundled WSGI server:

```bash
waitress-serve --host 0.0.0.0 --port 8080 --call mercury:create_app
```

To reach it from the field, put it behind a free tunnel — Cloudflare Tunnel or
Tailscale both work and neither costs anything. Offline capability means the app
tolerates that link being down for hours at a time.

---

## How the offline sync works

```
  Phone                                         Server
  ┌─────────────────────────┐                   ┌──────────────────┐
  │ IndexedDB replica       │                   │ SQLite           │
  │  jobs / customs / scans │ ── POST /api/sync ▶│  authoritative   │
  │ outbox (pending writes) │ ◀── delta ────────│  seq counter     │
  └─────────────────────────┘                   └──────────────────┘
        ▲                                              
        │ every screen reads from here, never the network
```

* **Client-generated UUIDs.** A phone with no signal mints its own row IDs, so
  they can never collide with the server's.
* **One round trip.** `POST /api/sync` pushes the outbox and pulls everything
  with `seq > since` in the same request.
* **Idempotent writes.** Every write upserts on the row's UUID, so a request
  that times out mid-flight can simply be retried.
* **Last-write-wins on `updated_at`.** A stale copy arriving late never
  overwrites a newer edit.
* **Soft deletes.** Deletions sync as tombstones, so a row deleted offline
  stays deleted instead of reappearing on the next pull.
* **Backoff, not errors.** A failed sync is the normal case in the field. The
  outbox stays put and the next attempt picks it up; nothing is ever lost and
  the technician is never asked to do anything about it.

The service worker precaches every screen and serves navigations network-first
with a cache fallback. The ~10 MB OCR engine is fetched in the background while
there's signal and cached from then on.

---

## Project layout

```
mercury/
  rates.py        pay rates and tier math — the source of truth for money
  models.py       week math, CRUD, dashboard aggregation
  sync.py         push/pull, conflict resolution
  invoicing.py    invoice numbering, due dates, line assembly
  exports/        xlsx and PDF generation
  blueprints/     web pages and JSON API
static/js/
  store.js        IndexedDB replica + outbox
  sync.js         sync engine, backoff, background sync
  local.js        week summary computed on-device
  hydrate.js      re-renders lists from the local replica
  scanner.js      AI + offline OCR label reading
  sw.js           service worker
tests/            60 tests, no network required
```

### Pay rules

* Aerial drops are tiered, not linear: **$75** to 300 ft, **$150** to 600 ft,
  then **$150 plus $0.50 for every foot past 601** — so a 601 ft drop is
  exactly $150 and a 780 ft drop is $239.50.
* Invoice terms are **net 14**: due fourteen days after the invoice date.

### Rates live in two places, on purpose

`mercury/rates.py` is authoritative. `static/js/app.js` mirrors it so an
offline device can price a job without asking the server. **Change both in the
same commit** — `tests/test_client_rates_match.py` fails if they drift.

---

## Tests

```bash
pip install pytest && python -m pytest tests/ -q
```

Covers the tier boundaries in the pay math, the sync contract (replay,
conflicts, tombstones, delta pulls, partial-batch failures), week boundaries,
invoice assembly, and the export pipeline.

---

## Backups

The whole database is one SQLite file. **Settings → Download a backup** gives
you a consistent copy while the app is running. Keep one off the machine.
