"""Runtime configuration.

Everything sensitive comes from the environment (or a local .env that is
git-ignored). The original app kept live credentials in a committed
config.ini; that file is not used any more.
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Minimal .env loader so there is no hard dependency on python-dotenv."""
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


_load_dotenv()


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


# Demo mode is a hard switch, not a preference: when it is on the app uses a
# separate database, a placeholder identity, and never sends real email.
DEMO = _bool("MERCURY_DEMO", False)


class Config:
    DEMO = DEMO

    # --- storage ---
    DATA_DIR = Path(os.environ.get("MERCURY_DATA_DIR", BASE_DIR / "data"))
    DB_PATH = DATA_DIR / "mercury.db"
    EXPORT_DIR = DATA_DIR / "exports"

    # --- web ---
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-change-me")
    HOST = os.environ.get("HOST", "0.0.0.0")
    PORT = int(os.environ.get("PORT", "8080"))
    # Optional shared passcode. Unset means the app is open on the LAN.
    ACCESS_PIN = os.environ.get("ACCESS_PIN", "").strip()

    # --- technician / invoice identity ---
    TECH_NAME = os.environ.get("TECH_NAME", "Matthew Cooper")
    TECH_ADDRESS_1 = os.environ.get("TECH_ADDRESS_1", "400 S 250 W")
    TECH_ADDRESS_2 = os.environ.get("TECH_ADDRESS_2", "Lagrange IN 46761")
    TECH_PHONE = os.environ.get("TECH_PHONE", "(574) 310-7482")
    TECH_EMAIL = os.environ.get("TECH_EMAIL", "coopmatth@gmail.com")

    BILL_TO_NAME = os.environ.get("BILL_TO_NAME", "Ritchie Installation and Communications")
    BILL_TO_ADDRESS_1 = os.environ.get("BILL_TO_ADDRESS_1", "2802 Congressional Parkway Suite B")
    BILL_TO_ADDRESS_2 = os.environ.get("BILL_TO_ADDRESS_2", "Fort Wayne IN 46808")
    BILL_TO_EMAIL = os.environ.get("BILL_TO_EMAIL", "rritchie@ritchieinstallations.com")

    # --- email ---
    SMTP_SERVER = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
    SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "")
    EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")
    YOUR_EMAIL = os.environ.get("YOUR_EMAIL", "") or TECH_EMAIL
    CONTRACTOR_EMAIL = os.environ.get("CONTRACTOR_EMAIL", "") or BILL_TO_EMAIL

    # --- AI equipment scanning (optional) ---
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
    # Model names turn over fast, so this is only a starting point — set
    # GEMINI_MODEL in .env and check Settings for what your key can use.
    GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip()
    GEMINI_MAX_OUTPUT_TOKENS = int(os.environ.get("GEMINI_MAX_OUTPUT_TOKENS", "2048"))

    # --- week definition ---
    # 6 = Sunday. The pay week runs Sunday through Saturday.
    WEEK_START_WEEKDAY = int(os.environ.get("WEEK_START_WEEKDAY", "6"))

    DEBUG = _bool("FLASK_DEBUG", False)

    @classmethod
    def email_configured(cls) -> bool:
        return bool(cls.SENDER_EMAIL and cls.EMAIL_PASSWORD)

    # Where demo-mode email is written instead of being sent.
    OUTBOX_DIR = DATA_DIR / "outbox"

    @classmethod
    def email_sends_for_real(cls) -> bool:
        """False in demo mode even with valid credentials configured."""
        return cls.email_configured() and not cls.DEMO

    @classmethod
    def ensure_dirs(cls) -> None:
        cls.DATA_DIR.mkdir(parents=True, exist_ok=True)
        cls.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        if cls.DEMO:
            cls.OUTBOX_DIR.mkdir(parents=True, exist_ok=True)


def _apply_demo_overrides() -> None:
    """Point the app at a throwaway database and a fictional technician.

    The real identity is someone's name, home address and phone number. A
    sandbox must never render those onto an invoice, so demo mode replaces
    them outright rather than trusting whatever is in .env.
    """
    Config.DATA_DIR = Path(os.environ.get("MERCURY_DATA_DIR", BASE_DIR / "data")) / "demo"
    Config.DB_PATH = Config.DATA_DIR / "mercury-demo.db"
    Config.EXPORT_DIR = Config.DATA_DIR / "exports"
    Config.OUTBOX_DIR = Config.DATA_DIR / "outbox"

    Config.TECH_NAME = "Alex Rivera"
    Config.TECH_ADDRESS_1 = "1200 Example Road"
    Config.TECH_ADDRESS_2 = "Springfield IN 46700"
    Config.TECH_PHONE = "(555) 010-4477"
    Config.TECH_EMAIL = "tech@example.test"

    Config.BILL_TO_NAME = "Northside Communications LLC"
    Config.BILL_TO_ADDRESS_1 = "480 Industrial Parkway"
    Config.BILL_TO_ADDRESS_2 = "Fort Wayne IN 46800"
    Config.BILL_TO_EMAIL = "billing@example.test"

    Config.CONTRACTOR_EMAIL = "billing@example.test"
    Config.YOUR_EMAIL = "tech@example.test"
    Config.SECRET_KEY = Config.SECRET_KEY or "demo-secret"


if DEMO:
    _apply_demo_overrides()


# Settings the running app is allowed to persist back into .env. An explicit
# allowlist so a caller can't be tricked into writing an arbitrary line by
# passing an unexpected key.
_SETTABLE_ENV_KEYS = {"GEMINI_MODEL", "CONTRACTOR_EMAIL", "YOUR_EMAIL"}


def update_env_file(values: dict[str, str], env_path: Path | None = None) -> None:
    """Persist settings into .env, replacing existing lines or appending new
    ones.

    Raises ValueError if a key isn't one this app writes, or a value could
    turn one line into two. That second check is the actual point: .env
    holds SMTP and API credentials, and a value containing a newline —
    accepted without this check — becomes a literal new line in the file,
    letting a request silently overwrite EMAIL_PASSWORD or any other setting
    it never named. Callers still validate the value's *shape* (an email,
    a model name, ...) before calling — this only guarantees the write
    itself can't be turned into something else.

    env_path defaults to BASE_DIR / ".env" — the real file this process was
    configured from — and is only ever overridden by tests. Deliberately a
    parameter rather than something a test monkeypatches on the BASE_DIR
    module global: other modules (blueprints/web.py, build.py) import
    BASE_DIR as a bare name at their own module level, so patching the
    shared global can permanently bind a *different* module to the patched
    value if it happens to be first-imported while the patch is active —
    order-dependent and exactly the kind of fragility this file shouldn't
    have, given what it's protecting.
    """
    for key, value in values.items():
        if key not in _SETTABLE_ENV_KEYS:
            raise ValueError(f"{key!r} is not a setting this app writes to .env.")
        if not isinstance(value, str) or set(value) & {"\n", "\r", "\x00"}:
            raise ValueError(f"Invalid value for {key}.")

    env_file = env_path or (BASE_DIR / ".env")
    lines = env_file.read_text().splitlines() if env_file.exists() else []
    remaining = dict(values)
    new_lines = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else None
        if key in remaining:
            new_lines.append(f"{key}={remaining.pop(key)}")
        else:
            new_lines.append(line)
    for key, value in remaining.items():
        new_lines.append(f"{key}={value}")

    env_file.write_text("\n".join(new_lines) + "\n")
