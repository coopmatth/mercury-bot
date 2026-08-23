"""Gemini-backed equipment label parsing.

Online this reads the hardware labels straight from photos. Offline the
browser falls back to on-device OCR (see static/js/scanner.js) and produces
the same block, so the technician's workflow does not change with signal.
"""
from __future__ import annotations

from .config import Config

# The output block is short; this only needs to be large enough to finish it.
MAX_OUTPUT_TOKENS = Config.GEMINI_MAX_OUTPUT_TOKENS

# The exact copy/paste block the technician pastes into the provisioning
# system. Field order matters to them, so it is fixed.
OUTPUT_TEMPLATE = """DROP= (AERIAL, HYBRID, NEEDS BURY)
ONT INFO
MAC = {ont_mac}
MTA MAC = {mta_mac}
FSAN = {ont_fsan}
S/N = {serial}
DB Levels/Light Levels = 
Fiber Jumper Length = 
LCP = 
ROUTER INFO 
FSAN = {router_fsan}
MAC = {router_mac}
Provision speeds = 
Actual Speeds = 
Uploaded Pictures (Yes/No) = 
Rough NID Location = """

PROMPT = """You are an expert fiber-optic technician's data-extraction assistant.
Analyze the provided hardware label images (Calix 1101/803 ONTs, GigaSpire u6/10GW
gateways, u4m mesh extenders) and extract the exact printed values.

Rules:
- ONT labels: MAC = ONU MAC, MTA MAC = MTA MAC, FSAN = FSAN, S/N = Serial NO.
- Router/gateway labels: FSAN = the SSID or FSAN/SSID value, MAC = MAC.
- Mesh extenders (u4m): append a "MESH EXTENDER INFO" section listing Serial
  Number, FSAN and MAC.
- Leave a field blank if it is not legible. Never invent a value.
- FSANs normally start with CXNK. MACs are 12 hex characters.

Output EXACTLY this template, filled in, with no commentary before or after:

""" + OUTPUT_TEMPLATE


class AIUnavailable(RuntimeError):
    pass


# Import result is cached: the probe below is not free, and it runs on every
# page render via the template context.
_sdk: object | None = None
_sdk_error: str | None = None
_probed = False


def _probe() -> None:
    """Import the SDK once, treating any failure as "AI is unavailable".

    This is deliberately broad. google-generativeai pulls in grpc and
    cryptography, whose native extensions can fail in ways that are not
    ImportError — a mismatched cryptography build raises pyo3's
    PanicException, which inherits from BaseException and so sails straight
    past `except Exception`. AI is an optional extra; a broken optional
    extra must never take down job logging, which is the part that has to
    work in a field with no signal.
    """
    global _sdk, _sdk_error, _probed
    if _probed:
        return
    _probed = True
    try:
        import google.generativeai as genai
        _sdk = genai
    except ImportError:
        _sdk_error = ("google-generativeai is not installed. Run: "
                      "pip install -r requirements-ai.txt")
    except (KeyboardInterrupt, SystemExit):
        _probed = False
        raise
    except BaseException as exc:  # noqa: BLE001 — see docstring
        _sdk_error = (f"google-generativeai is installed but failed to load "
                      f"({type(exc).__name__}: {exc}). Reinstall it, or remove "
                      f"it to silence this — the scanner uses on-device OCR "
                      f"either way.")


def available() -> bool:
    if not Config.GEMINI_API_KEY:
        return False
    _probe()
    return _sdk is not None


def load_error() -> str | None:
    """Why the SDK is unusable, if it is installed but broken."""
    if not Config.GEMINI_API_KEY:
        return None
    _probe()
    return _sdk_error


def _client():
    """Configured SDK module, or a clear reason why not."""
    if not Config.GEMINI_API_KEY:
        raise AIUnavailable("No GEMINI_API_KEY configured — using offline OCR instead.")
    _probe()
    if _sdk is None:
        raise AIUnavailable(_sdk_error or "google-generativeai is unavailable.")
    _sdk.configure(api_key=Config.GEMINI_API_KEY)
    return _sdk


def available_models() -> list[str]:
    """Model names this API key can actually generate with.

    Asked of the API rather than hardcoded: model names turn over quickly,
    and a list baked into the source is wrong the moment Google ships the
    next one.
    """
    genai = _client()
    names = []
    for model in genai.list_models():
        if "generateContent" in getattr(model, "supported_generation_methods", []):
            names.append(model.name.removeprefix("models/"))
    return sorted(names)


def _model_hint() -> str:
    """Appended to a model failure: what this key could use instead."""
    try:
        names = available_models()
    except Exception:
        return ""
    if not names:
        return ""
    vision = [n for n in names if "flash" in n or "pro" in n]
    return ("  Models this key can use: " + ", ".join((vision or names)[:12])
            + ".  Set GEMINI_MODEL in .env to one of these.")


def parse_equipment_images(images: list) -> str:
    """Return the filled copy/paste block for a set of PIL images."""
    genai = _client()
    model_name = Config.GEMINI_MODEL

    try:
        model = genai.GenerativeModel(model_name)
        response = model.generate_content(
            [PROMPT] + images,
            generation_config={"temperature": 0, "max_output_tokens": MAX_OUTPUT_TOKENS},
        )
    except Exception as exc:
        # A wrong or retired model name is the likeliest cause, and the raw
        # SDK error does not say which name was tried.
        raise AIUnavailable(
            f"Gemini rejected model '{model_name}': {exc}.{_model_hint()}"
        ) from exc

    text = _text_from(response, model_name)
    # Strip a markdown fence if the model wrapped the block in one.
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return text


def _text_from(response, model_name: str) -> str:
    """Pull the text out, explaining an empty result rather than hiding it."""
    text = ""
    try:
        text = (getattr(response, "text", "") or "").strip()
    except Exception:
        # The SDK raises rather than returning text when nothing was produced.
        text = ""
    if text:
        return text

    reason = ""
    for candidate in getattr(response, "candidates", None) or []:
        finish = getattr(candidate, "finish_reason", None)
        if finish:
            reason = str(getattr(finish, "name", finish))
            break
    blocked = getattr(getattr(response, "prompt_feedback", None), "block_reason", None)

    if blocked:
        raise AIUnavailable(f"Gemini blocked the request ({blocked}). Using offline OCR.")
    if reason and "MAX_TOKENS" in reason:
        raise AIUnavailable(
            f"'{model_name}' hit the output limit before finishing. Raise "
            "GEMINI_MAX_OUTPUT_TOKENS in .env, or try a different model."
        )
    if reason:
        raise AIUnavailable(f"'{model_name}' returned nothing ({reason}).{_model_hint()}")
    raise AIUnavailable(f"'{model_name}' returned no text for these images.{_model_hint()}")
