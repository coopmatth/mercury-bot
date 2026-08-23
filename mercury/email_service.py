"""Outbound email over SMTP.

Kept deliberately close to the original: the same Gmail app-password flow,
just with the credentials pulled from the environment and with HTML bodies
so the reports arrive looking like something a contractor wants to open.
"""
from __future__ import annotations

import mimetypes
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

from .config import Config


class EmailError(RuntimeError):
    pass


def _html_wrap(title: str, intro: str, rows: list[tuple[str, str]] | None = None,
               footer: str = "") -> str:
    row_html = "".join(
        f'<tr><td style="padding:6px 14px 6px 0;color:#64748b;font-size:13px">{k}</td>'
        f'<td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600">{v}</td></tr>'
        for k, v in (rows or [])
    )
    return f"""\
<html><body style="margin:0;padding:24px;background:#f1f5f9;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;
    box-shadow:0 1px 3px rgba(15,23,42,.12)">
    <div style="background:#0f172a;padding:20px 28px">
      <div style="color:#38bdf8;font-size:11px;letter-spacing:1.5px;font-weight:700">MERCURY TRACKER</div>
      <div style="color:#fff;font-size:19px;font-weight:700;margin-top:4px">{title}</div>
    </div>
    <div style="padding:24px 28px">
      <p style="color:#334155;font-size:14px;line-height:1.6;margin:0 0 16px">{intro}</p>
      <table style="border-collapse:collapse;width:100%">{row_html}</table>
      <p style="color:#94a3b8;font-size:12px;margin:22px 0 0">{footer or Config.TECH_NAME}</p>
    </div>
  </div>
</body></html>"""


def send_email(recipient: str, subject: str, body_text: str,
               attachments: list[Path] | None = None,
               body_html: str | None = None) -> None:
    """Send one message. Raises EmailError with a usable reason on failure."""
    if not recipient:
        raise EmailError("No recipient address configured.")
    if not Config.DEMO and not Config.email_configured():
        raise EmailError(
            "Email is not configured. Set SENDER_EMAIL and EMAIL_PASSWORD in .env."
        )

    msg = EmailMessage()
    sender = Config.SENDER_EMAIL or (Config.TECH_EMAIL if Config.DEMO else "")
    msg["From"] = f"{Config.TECH_NAME} <{sender}>"
    msg["To"] = recipient
    msg["Subject"] = subject
    msg.set_content(body_text)
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    for path in (attachments or []):
        path = Path(path)
        if not path.exists():
            continue
        ctype, _ = mimetypes.guess_type(path.name)
        maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
        msg.add_attachment(path.read_bytes(), maintype=maintype,
                           subtype=subtype, filename=path.name)

    if Config.DEMO:
        # Sandbox: write the message to disk so it can be inspected, and do
        # not open a connection to anything.
        _save_to_outbox(msg, subject)
        return

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(Config.SMTP_SERVER, Config.SMTP_PORT, timeout=30) as server:
            server.starttls(context=context)
            server.login(Config.SENDER_EMAIL, Config.EMAIL_PASSWORD)
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError as exc:
        raise EmailError(
            "SMTP rejected the login. For Gmail you need a 16-character App "
            "Password, not your account password."
        ) from exc
    except Exception as exc:
        raise EmailError(f"Could not send email: {exc}") from exc


def _save_to_outbox(msg: EmailMessage, subject: str) -> None:
    """Demo mode's stand-in for sending: a real .eml file, openable in any
    mail client, written to data/demo/outbox."""
    Config.ensure_dirs()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe = "".join(c if c.isalnum() or c in " -_" else "" for c in subject)[:60].strip()
    (Config.OUTBOX_DIR / f"{stamp} {safe or 'message'}.eml").write_bytes(msg.as_bytes())


def send_report(recipient: str, title: str, intro: str,
                rows: list[tuple[str, str]], attachments: list[Path]) -> None:
    send_email(
        recipient=recipient,
        subject=title,
        body_text=f"{title}\n\n{intro}\n\n"
                  + "\n".join(f"{k}: {v}" for k, v in rows),
        attachments=attachments,
        body_html=_html_wrap(title, intro, rows),
    )
