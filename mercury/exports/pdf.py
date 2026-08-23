"""Invoice PDFs.

Same document the original produced — sender block, bill-to block, a ruled
line-item table and a balance due — rebuilt so it paginates properly, wraps
long descriptions instead of running off the page, and takes its line items
from the database rather than re-reading a spreadsheet.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from ..config import Config

MARGIN = 0.9 * inch
PAGE_W, PAGE_H = letter

NAVY = colors.HexColor("#0F172A")
SLATE = colors.HexColor("#475569")
RULE = colors.HexColor("#CBD5E1")
ACCENT = colors.HexColor("#0EA5E9")

COL_RATE_R = PAGE_W - MARGIN - 2.55 * inch
COL_QTY_R = PAGE_W - MARGIN - 1.5 * inch
COL_AMT_R = PAGE_W - MARGIN
# Descriptions wrap well clear of the right-aligned rate column so long
# line items can never collide with the numbers.
DESC_WIDTH = COL_RATE_R - MARGIN - 0.95 * inch


def _fmt_qty(value: float) -> str:
    if float(value).is_integer():
        return str(int(value))
    return f"{value:g}"


def _wrap(text: str, font: str, size: float, width: float) -> list[str]:
    """Greedy word wrap against the real rendered width."""
    words = str(text).split()
    if not words:
        return [""]
    lines, current = [], words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if stringWidth(candidate, font, size) <= width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _header(c: canvas.Canvas, title: str, number: str, issued: str,
            due: str, period: str, total: float) -> float:
    """Draw the letterhead. Returns the y coordinate to continue from."""
    c.setFillColor(NAVY)
    c.rect(0, PAGE_H - 0.35 * inch, PAGE_W, 0.35 * inch, stroke=0, fill=1)

    y = PAGE_H - 1.05 * inch
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 15)
    c.drawString(MARGIN, y, Config.TECH_NAME)
    c.setFillColor(SLATE)
    c.setFont("Helvetica", 9.5)
    for offset, line in enumerate((Config.TECH_ADDRESS_1, Config.TECH_ADDRESS_2,
                                  Config.TECH_PHONE, Config.TECH_EMAIL), start=1):
        c.drawString(MARGIN, y - offset * 13, line)

    # Right-hand invoice meta block
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 20)
    c.drawRightString(COL_AMT_R, y + 2, "INVOICE")

    meta_y = y - 22
    rows = [("INVOICE #", number), ("DATE", issued), ("DUE DATE", due)]
    if period:
        rows.insert(1, ("PERIOD", period))
    c.setFont("Helvetica-Bold", 8)
    for label, value in rows:
        c.setFillColor(SLATE)
        c.drawRightString(COL_AMT_R - 1.35 * inch, meta_y, label)
        c.setFillColor(NAVY)
        c.setFont("Helvetica", 9)
        c.drawRightString(COL_AMT_R, meta_y, value)
        c.setFont("Helvetica-Bold", 8)
        meta_y -= 13

    # Balance-due callout
    box_h = 0.42 * inch
    box_y = meta_y - box_h - 2
    c.setFillColor(NAVY)
    c.roundRect(COL_AMT_R - 2.1 * inch, box_y, 2.1 * inch, box_h, 4, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica", 8)
    c.drawString(COL_AMT_R - 2.0 * inch, box_y + box_h - 14, "BALANCE DUE")
    c.setFont("Helvetica-Bold", 14)
    c.drawRightString(COL_AMT_R - 0.1 * inch, box_y + 7, f"${total:,.2f}")

    # Bill-to
    bill_y = min(y - 5 * 13, box_y) - 26
    c.setFillColor(ACCENT)
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(MARGIN, bill_y, "BILL TO")
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(MARGIN, bill_y - 15, Config.BILL_TO_NAME)
    c.setFillColor(SLATE)
    c.setFont("Helvetica", 9.5)
    for offset, line in enumerate((Config.BILL_TO_ADDRESS_1, Config.BILL_TO_ADDRESS_2,
                                  Config.BILL_TO_EMAIL), start=2):
        c.drawString(MARGIN, bill_y - 15 - (offset - 1) * 12, line)

    return bill_y - 15 - 3 * 12 - 26


def _footer(c: canvas.Canvas, page: int) -> None:
    """Page number only — an invoice carries no software branding."""
    c.setFillColor(SLATE)
    c.setFont("Helvetica", 7.5)
    c.drawRightString(PAGE_W - MARGIN, MARGIN - 24, f"Page {page}")


def _table_head(c: canvas.Canvas, y: float) -> float:
    c.setFillColor(NAVY)
    c.rect(MARGIN, y - 4, PAGE_W - 2 * MARGIN, 20, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(MARGIN + 8, y + 3, "DESCRIPTION")
    c.drawRightString(COL_RATE_R, y + 3, "RATE")
    c.drawRightString(COL_QTY_R, y + 3, "QTY")
    c.drawRightString(COL_AMT_R - 8, y + 3, "AMOUNT")
    return y - 14


def build_invoice_pdf(
    *,
    filename: str,
    number: str,
    lines: list[dict],
    total: float,
    issued: date,
    due: str,
    period: str = "",
) -> Path:
    Config.ensure_dirs()
    path = Config.EXPORT_DIR / filename
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setTitle(f"Invoice {number}")

    y = _header(c, "INVOICE", number, issued.strftime("%m/%d/%y"), due, period, total)
    y = _table_head(c, y)

    row_bg = False
    page = 1
    for line in lines:
        wrapped = _wrap(line["description"], "Helvetica", 9.5, DESC_WIDTH)
        row_h = max(20, 6 + 12 * len(wrapped))

        if y - row_h < MARGIN + 60:          # not enough room — new page
            _footer(c, page)
            c.showPage()
            page += 1
            y = _table_head(c, PAGE_H - MARGIN)

        if row_bg:
            c.setFillColor(colors.HexColor("#F8FAFC"))
            c.rect(MARGIN, y - row_h + 12, PAGE_W - 2 * MARGIN, row_h, stroke=0, fill=1)
        row_bg = not row_bg

        c.setFillColor(NAVY)
        c.setFont("Helvetica", 9.5)
        for i, text in enumerate(wrapped):
            c.drawString(MARGIN + 8, y - i * 12, text)
        c.drawRightString(COL_RATE_R, y, f"${line['rate']:,.2f}")
        c.drawRightString(COL_QTY_R, y, _fmt_qty(line["qty"]))
        c.setFont("Helvetica-Bold", 9.5)
        c.drawRightString(COL_AMT_R - 8, y, f"${line['amount']:,.2f}")

        y -= row_h
        c.setStrokeColor(RULE)
        c.setLineWidth(0.5)
        c.line(MARGIN, y + 10, PAGE_W - MARGIN, y + 10)

    # Totals
    y -= 12
    if y < MARGIN + 60:
        _footer(c, page)
        c.showPage()
        page += 1
        y = PAGE_H - MARGIN - 40
    c.setStrokeColor(NAVY)
    c.setLineWidth(1.2)
    c.line(COL_QTY_R - 1.2 * inch, y + 16, PAGE_W - MARGIN, y + 16)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(COL_QTY_R, y, "BALANCE DUE")
    c.drawRightString(COL_AMT_R, y, f"${total:,.2f}")

    # A single-page invoice does not need a page number.
    if page > 1:
        _footer(c, page)
    c.save()
    return path
