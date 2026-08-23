"""Gemini-backed equipment label parsing.

Online this reads the hardware labels straight from photos. Offline the
browser falls back to on-device OCR (see static/js/scanner.js) and produces
the same block, so the technician's workflow does not change with signal.
"""
from __future__ import annotations

from .config import Config

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


def available() -> bool:
    if not Config.GEMINI_API_KEY:
        return False
    try:
        import google.generativeai  # noqa: F401
    except ImportError:
        return False
    return True


def parse_equipment_images(images: list) -> str:
    """Return the filled copy/paste block for a set of PIL images."""
    if not Config.GEMINI_API_KEY:
        raise AIUnavailable("No GEMINI_API_KEY configured — using offline OCR instead.")
    try:
        import google.generativeai as genai
    except ImportError as exc:
        raise AIUnavailable(
            "google-generativeai is not installed — using offline OCR instead."
        ) from exc

    genai.configure(api_key=Config.GEMINI_API_KEY)
    model = genai.GenerativeModel(Config.GEMINI_MODEL)
    response = model.generate_content([PROMPT] + images)
    text = (getattr(response, "text", "") or "").strip()
    if not text:
        raise AIUnavailable("The model returned no text for these images.")
    # Strip a markdown fence if the model wrapped the block in one.
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    return text
