#!/usr/bin/env python3
"""Convert a markdown document to PDF using reportlab.

Usage:
    python3 _md_to_pdf.py <input.md> <output.pdf> [--title "..."] [--footer "..."]

Defaults (when invoked with no args, for back-compat):
    INPUT  = Neuromorphic-DHT-Architecture.md
    OUTPUT = Neuromorphic-DHT-Architecture.pdf
"""

import re
import os
import sys
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib.colors import HexColor
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted,
    Table, TableStyle, KeepTogether
)

INPUT  = os.path.join(os.path.dirname(__file__), "Neuromorphic-DHT-Architecture.md")
OUTPUT = os.path.join(os.path.dirname(__file__), "Neuromorphic-DHT-Architecture.pdf")
TITLE  = "Neuromorphic DHT Architecture"
FOOTER = "Neuromorphic DHT Architecture v0.56.00"

if len(sys.argv) >= 3:
    INPUT  = sys.argv[1]
    OUTPUT = sys.argv[2]
    for i, a in enumerate(sys.argv[3:], start=3):
        if a == '--title' and i + 1 < len(sys.argv):
            TITLE = sys.argv[i + 1]
        elif a == '--footer' and i + 1 < len(sys.argv):
            FOOTER = sys.argv[i + 1]

# ── Styles ────────────────────────────────────────────────────────────────────

styles = getSampleStyleSheet()

styles.add(ParagraphStyle(
    'DocTitle', parent=styles['Title'], fontSize=22, spaceAfter=6,
    textColor=HexColor('#1a1a2e')
))
styles.add(ParagraphStyle(
    'DocSubtitle', parent=styles['Normal'], fontSize=12, alignment=TA_CENTER,
    spaceAfter=4, textColor=HexColor('#555555'), fontName='Helvetica-Oblique'
))
styles.add(ParagraphStyle(
    'DocVersion', parent=styles['Normal'], fontSize=10, alignment=TA_CENTER,
    spaceAfter=24, textColor=HexColor('#888888')
))
styles.add(ParagraphStyle(
    'ChapterHeading', parent=styles['Heading1'], fontSize=18, spaceBefore=24,
    spaceAfter=12, textColor=HexColor('#1a1a2e'), fontName='Helvetica-Bold'
))
styles.add(ParagraphStyle(
    'SectionHeading', parent=styles['Heading2'], fontSize=14, spaceBefore=18,
    spaceAfter=8, textColor=HexColor('#2d3436'), fontName='Helvetica-Bold'
))
styles.add(ParagraphStyle(
    'SubsectionHeading', parent=styles['Heading3'], fontSize=12, spaceBefore=14,
    spaceAfter=6, textColor=HexColor('#2d3436'), fontName='Helvetica-Bold'
))
styles.add(ParagraphStyle(
    'Body', parent=styles['Normal'], fontSize=10, leading=14,
    alignment=TA_JUSTIFY, spaceAfter=6, fontName='Helvetica'
))
styles.add(ParagraphStyle(
    'BoldBody', parent=styles['Normal'], fontSize=10, leading=14,
    spaceAfter=6, fontName='Helvetica-Bold'
))
styles.add(ParagraphStyle(
    'CodeBlock', parent=styles['Code'], fontSize=8, leading=10,
    spaceAfter=8, spaceBefore=4, backColor=HexColor('#f5f5f5'),
    leftIndent=12, rightIndent=12, fontName='Courier'
))
styles.add(ParagraphStyle(
    'BulletItem', parent=styles['Normal'], fontSize=10, leading=14,
    leftIndent=24, bulletIndent=12, spaceAfter=3, fontName='Helvetica'
))
styles.add(ParagraphStyle(
    'NumberedItem', parent=styles['Normal'], fontSize=10, leading=14,
    leftIndent=24, bulletIndent=12, spaceAfter=3, fontName='Helvetica'
))

# ── Markdown to flowables ────────────────────────────────────────────────────

def escape_xml(text):
    """Escape XML special chars but preserve our markup tags."""
    text = text.replace('&', '&amp;')
    text = text.replace('<', '&lt;')
    text = text.replace('>', '&gt;')
    return text

def inline_format(text):
    """Convert markdown inline formatting to reportlab XML."""
    # Bold + italic
    text = re.sub(r'\*\*\*(.+?)\*\*\*', r'<b><i>\1</i></b>', text)
    # Bold
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    # Italic
    text = re.sub(r'\*(.+?)\*', r'<i>\1</i>', text)
    # Inline code
    text = re.sub(r'`([^`]+)`', r'<font face="Courier" size="9">\1</font>', text)
    # Links - just show text
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    return text

def parse_table(lines):
    """Parse markdown table lines into a reportlab Table."""
    rows = []
    for line in lines:
        line = line.strip().strip('|')
        cells = [c.strip() for c in line.split('|')]
        rows.append(cells)

    if len(rows) < 2:
        return None

    # Check if second row is separator
    if all(re.match(r'^[-:]+$', c) for c in rows[1]):
        header = rows[0]
        data = rows[2:]
    else:
        header = rows[0]
        data = rows[1:]

    table_data = [header] + data

    # Format cells
    formatted = []
    for i, row in enumerate(table_data):
        fmt_row = []
        for cell in row:
            cell = inline_format(cell)
            style = 'Helvetica-Bold' if i == 0 else 'Helvetica'
            size = 8
            fmt_row.append(Paragraph(
                f'<font face="{style}" size="{size}">{cell}</font>',
                styles['Normal']
            ))
        formatted.append(fmt_row)

    ncols = max(len(r) for r in formatted)
    # Pad short rows
    for row in formatted:
        while len(row) < ncols:
            row.append(Paragraph('', styles['Normal']))

    col_width = (6.5 * inch) / ncols
    t = Table(formatted, colWidths=[col_width] * ncols)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#e8e8e8')),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#cccccc')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    return t

def md_to_flowables(md_text):
    """Convert markdown text to a list of reportlab flowables."""
    lines = md_text.split('\n')
    flowables = []
    i = 0
    in_code = False
    code_lines = []
    title_done = False

    while i < len(lines):
        line = lines[i]

        # Code blocks
        if line.strip().startswith('```'):
            if in_code:
                code_text = escape_xml('\n'.join(code_lines))
                flowables.append(Preformatted(code_text, styles['CodeBlock']))
                code_lines = []
                in_code = False
            else:
                in_code = True
            i += 1
            continue

        if in_code:
            code_lines.append(line)
            i += 1
            continue

        stripped = line.strip()

        # Skip horizontal rules
        if stripped == '---':
            i += 1
            continue

        # Empty lines
        if not stripped:
            i += 1
            continue

        # Title
        if stripped.startswith('# ') and not title_done:
            title_text = stripped[2:]
            flowables.append(Paragraph(title_text, styles['DocTitle']))
            title_done = True
            i += 1
            continue

        # Subtitle (bold italic line after title)
        if stripped.startswith('**') and stripped.endswith('**') and not any(
            isinstance(f, Paragraph) and f.style.name == 'Body' for f in flowables
        ):
            text = stripped.strip('*')
            flowables.append(Paragraph(text, styles['DocSubtitle']))
            i += 1
            continue

        # Version line
        if stripped.startswith('*Version') and stripped.endswith('*'):
            text = stripped.strip('*')
            flowables.append(Paragraph(text, styles['DocVersion']))
            i += 1
            continue

        # Chapter headings (## Chapter or ## Introduction or ## References or ## Appendix)
        if stripped.startswith('## '):
            text = stripped[3:]
            flowables.append(Spacer(1, 12))
            flowables.append(Paragraph(inline_format(text), styles['ChapterHeading']))
            i += 1
            continue

        # Section headings (### X.Y)
        if stripped.startswith('### '):
            text = stripped[4:]
            flowables.append(Paragraph(inline_format(text), styles['SectionHeading']))
            i += 1
            continue

        # Subsubsection (#### X.Y.Z)
        if stripped.startswith('#### '):
            text = stripped[5:]
            flowables.append(Paragraph(inline_format(text), styles['SubsectionHeading']))
            i += 1
            continue

        # Tables
        if '|' in stripped and not stripped.startswith('|--'):
            table_lines = []
            while i < len(lines) and '|' in lines[i].strip():
                table_lines.append(lines[i])
                i += 1
            table = parse_table(table_lines)
            if table:
                flowables.append(Spacer(1, 4))
                flowables.append(table)
                flowables.append(Spacer(1, 4))
            continue

        # Bullet points
        if stripped.startswith('- ') or stripped.startswith('* '):
            text = inline_format(stripped[2:])
            flowables.append(Paragraph(
                f'\u2022 {text}', styles['BulletItem']
            ))
            i += 1
            continue

        # Numbered items
        m = re.match(r'^(\d+)\.\s+(.*)', stripped)
        if m:
            num, text = m.group(1), inline_format(m.group(2))
            flowables.append(Paragraph(
                f'{num}. {text}', styles['NumberedItem']
            ))
            i += 1
            continue

        # Checkbox items
        if stripped.startswith('- [ ] '):
            text = inline_format(stripped[6:])
            flowables.append(Paragraph(
                f'\u25a1 {text}', styles['BulletItem']
            ))
            i += 1
            continue

        # Regular paragraph - collect consecutive lines
        para_lines = [stripped]
        i += 1
        while i < len(lines):
            next_line = lines[i].strip()
            if (not next_line or next_line.startswith('#') or next_line.startswith('```')
                or next_line.startswith('|') or next_line.startswith('- ')
                or next_line.startswith('* ') or re.match(r'^\d+\.', next_line)
                or next_line == '---'):
                break
            para_lines.append(next_line)
            i += 1

        text = inline_format(' '.join(para_lines))
        flowables.append(Paragraph(text, styles['Body']))

    return flowables

# ── Build PDF ────────────────────────────────────────────────────────────────

def build_pdf():
    with open(INPUT, 'r', encoding='utf-8') as f:
        md_text = f.read()

    doc = SimpleDocTemplate(
        OUTPUT,
        pagesize=letter,
        leftMargin=1*inch,
        rightMargin=1*inch,
        topMargin=0.75*inch,
        bottomMargin=0.75*inch,
        title=TITLE,
        author="DHT Research",
    )

    flowables = md_to_flowables(md_text)

    def add_page_number(canvas, doc):
        canvas.saveState()
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(HexColor('#888888'))
        canvas.drawRightString(
            letter[0] - 1*inch,
            0.5*inch,
            f"Page {doc.page}"
        )
        canvas.drawString(
            1*inch,
            0.5*inch,
            FOOTER,
        )
        canvas.restoreState()

    doc.build(flowables, onFirstPage=add_page_number, onLaterPages=add_page_number)
    print(f"PDF generated: {OUTPUT}")

if __name__ == '__main__':
    build_pdf()
