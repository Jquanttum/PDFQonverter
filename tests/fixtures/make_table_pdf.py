"""Builds tests/fixtures/table.pdf with reportlab: a stock report whose table continues on a second page.
It is the independent source for the PDF -> Excel tests, so the table detector is not tested only against its own output.
All names and numbers are fictional.   python3 make_table_pdf.py
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = A4
RIGHT = {'Qty': 300, 'Unit price': 410, 'Total': 520}

rows = [
    ('Maize (50kg bag)', '12', '350.50', '4,206.00'),
    ('Rice - parboiled', '3', '0.30', '0.90'),
    ('Yam, large', '40', '12.35', '494.00'),
    ('Groundnut oil 5L', '', '95.00', '(95.00)'),         # a blank quantity and a negative amount in brackets
    ('Plantain (bunch)', '25', '18.00', '450.00'),
    ('Tomato paste', '60', '4.25', '255.00'),
    ('Shea butter 250g', '8', '22.00', '176.00'),
    ('Palm oil 1L', '15', '14.50', '217.50'),
    ('Cassava flour', '30', '6.00', '180.00'),
    ('Kenkey (dozen)', '7', '35.00', '245.00'),
    ('Pepper, dried', '4', '1,250.00', '5,000.00'),
    ('Sugar 1kg', '50', '9.50', '475.00'),
    ('Salt 500g', '100', '1.50', '150.00'),
    ('Total', '', '', '11,998.40'),
]


def header(c, y):
    c.setFont('Helvetica-Bold', 10)
    c.drawString(72, y, 'Item')
    for name, x in RIGHT.items():
        c.drawRightString(x, y, name)


def line(c, y, r):
    c.setFont('Helvetica', 10)
    c.drawString(72, y, r[0])
    for (name, x), v in zip(RIGHT.items(), r[1:]):
        if v:
            c.drawRightString(x, y, v)


c = canvas.Canvas(os.path.join(HERE, 'table.pdf'), pagesize=A4)
c.setTitle('Stock report')
c.setFont('Helvetica-Bold', 16)
c.drawString(72, H - 72, 'Stock report - Kumasi branch')
c.setFont('Helvetica', 10)
c.drawString(72, H - 92, 'Prepared for the March review')
y = H - 130
header(c, y)
for r in rows[:8]:
    y -= 18
    line(c, y, r)
c.showPage()
y = H - 72
header(c, y)                      # the header repeats when the table continues
for r in rows[8:]:
    y -= 18
    line(c, y, r)
c.setFont('Helvetica', 9)
c.drawString(72, y - 40, 'Prepared by A. Mensah')
c.showPage()
c.save()
print('ok')
