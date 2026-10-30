#!/usr/bin/env python3
"""Rebuilds the workbooks that tests/xlsx.test.ts reads.

    python3 tests/fixtures/xlsx/make-fixtures.py [--lo-profile DIR]

Needs openpyxl (pip install openpyxl) and LibreOffice's soffice on the PATH.
--lo-profile is the LibreOffice profile folder to use; by default a fresh
temporary one, so a LibreOffice already open on this computer doesn't lock
the conversion. The files are written next to this script, and the tests
expect exactly what is written here: change one and change the other.
"""

import argparse
import datetime
import os
import shutil
import subprocess
import tempfile

import openpyxl
from openpyxl.styles import Font
from openpyxl.utils.datetime import CALENDAR_MAC_1904

HERE = os.path.dirname(os.path.abspath(__file__))

# Fixed so rebuilding doesn't change the files for nothing.
WHEN = datetime.datetime(2026, 1, 1)


def save(workbook, name):
    workbook.properties.creator = "make-fixtures.py"
    workbook.properties.created = WHEN
    workbook.properties.modified = WHEN
    workbook.save(os.path.join(HERE, name))


def customers_openpyxl():
    """A customer list as a script would export it. openpyxl writes text as
    inline strings (no sharedStrings.xml), dates as numbers with a date
    format, and formulas with no calculated value."""
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Customers"
    sheet.append(["First name", "Last name", "Phone", "Email", "Customer since", "Last visit",
                  "Callback", "Balance", "Tax exempt", "Notes"])
    sheet.append(["Dana", "O'Brien", 8145550199, "dana@example.com", datetime.date(2019, 3, 5),
                  datetime.datetime(2024, 6, 1, 9, 15), datetime.time(13, 45), 1.5, False,
                  "Rides a RZR & a Sportsman <2 seats>"])
    sheet.append(["Zoë", "Müller", "(814) 555-0123", "zoe@example.com", datetime.date(2023, 11, 20),
                  datetime.datetime(2024, 6, 2, 16, 5, 30), None, 0.1 + 0.2, True,
                  "Gate code 1234\nCall first"])
    # Row 4 is left empty. Row 5 has gaps, a ZIP code kept as text and a
    # formula openpyxl can't calculate.
    for column, value in {"A": "Lee", "C": "01234", "H": "=H2+H3", "J": "  spaces kept  "}.items():
        sheet[f"{column}5"] = value
    # A styled cell with nothing in it, below the data: not a row.
    sheet["D8"].font = Font(bold=True)

    hidden = book.create_sheet("Old customers")
    hidden.append(["Not", "imported"])
    hidden.sheet_state = "hidden"

    notes = book.create_sheet("Notes")
    notes.append(["Imported from the old DMS", 42])
    notes.append(["Share", 0.25])
    notes["B2"].number_format = "0%"

    lists = book.create_sheet("Lists")
    lists.append(["veryHidden"])
    lists.sheet_state = "veryHidden"
    save(book, "customers-openpyxl.xlsx")


def dates_1904_openpyxl():
    """Dates counted from 1904, as Excel for Mac once saved them."""
    book = openpyxl.Workbook()
    book.epoch = CALENDAR_MAC_1904
    sheet = book.active
    sheet.title = "Dates"
    sheet.append([datetime.date(2019, 3, 5), datetime.datetime(2024, 6, 1, 9, 15),
                  datetime.date(1904, 1, 1), datetime.time(6, 30)])
    save(book, "dates-1904-openpyxl.xlsx")


def iso_dates_openpyxl():
    """Dates as ISO 8601 text in t="d" cells instead of numbers."""
    book = openpyxl.Workbook()
    book.iso_dates = True
    sheet = book.active
    sheet.title = "Dates"
    sheet.append([datetime.date(2019, 3, 5), datetime.datetime(2023, 11, 20, 14, 30, 15),
                  datetime.time(13, 45)])
    save(book, "iso-dates-openpyxl.xlsx")


# A LibreOffice Calc spreadsheet in flat XML, with typed cells: dates, a
# time, booleans, formulas with their results (one an error), a hidden sheet.
FODS = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"
 xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:automatic-styles>
 <number:date-style style:name="N1"><number:month/><number:text>/</number:text><number:day/><number:text>/</number:text><number:year number:style="long"/></number:date-style>
 <number:date-style style:name="N2"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/><number:text> </number:text><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/></number:date-style>
 <number:time-style style:name="N3"><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/></number:time-style>
 <number:boolean-style style:name="N4"><number:boolean/></number:boolean-style>
 <style:style style:name="ce1" style:family="table-cell" style:data-style-name="N1"/>
 <style:style style:name="ce2" style:family="table-cell" style:data-style-name="N2"/>
 <style:style style:name="ce3" style:family="table-cell" style:data-style-name="N3"/>
 <style:style style:name="ce4" style:family="table-cell" style:data-style-name="N4"/>
 <style:style style:name="ta1" style:family="table"><style:table-properties table:display="true"/></style:style>
 <style:style style:name="ta2" style:family="table"><style:table-properties table:display="false"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
<table:table table:name="Customers" table:style-name="ta1">
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>First name</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Last name</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Phone</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Customer since</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Last visit</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Callback</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Balance</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Tax exempt</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Notes</text:p></table:table-cell>
 </table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>Dana</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>O'Brien</text:p></table:table-cell>
  <table:table-cell office:value-type="float" office:value="8145550199"><text:p>8145550199</text:p></table:table-cell>
  <table:table-cell office:value-type="date" office:date-value="2019-03-05" table:style-name="ce1"><text:p>3/5/2019</text:p></table:table-cell>
  <table:table-cell office:value-type="date" office:date-value="2024-06-01T09:15:00" table:style-name="ce2"><text:p>2024-06-01 09:15</text:p></table:table-cell>
  <table:table-cell office:value-type="time" office:time-value="PT13H45M00S" table:style-name="ce3"><text:p>13:45</text:p></table:table-cell>
  <table:table-cell office:value-type="float" office:value="1.5"><text:p>1.5</text:p></table:table-cell>
  <table:table-cell office:value-type="boolean" office:boolean-value="false" table:style-name="ce4"><text:p>FALSE</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Rides a RZR &amp; a Sportsman &lt;2 seats&gt;</text:p></table:table-cell>
 </table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>Zoë</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Müller</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>(814) 555-0123</text:p></table:table-cell>
  <table:table-cell office:value-type="date" office:date-value="2023-11-20" table:style-name="ce1"><text:p>11/20/2023</text:p></table:table-cell>
  <table:table-cell table:number-columns-repeated="2"/>
  <table:table-cell office:value-type="float" office:value="0.30000000000000004"><text:p>0.3</text:p></table:table-cell>
  <table:table-cell office:value-type="boolean" office:boolean-value="true" table:style-name="ce4"><text:p>TRUE</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Gate code 1234</text:p><text:p>Call first</text:p></table:table-cell>
 </table:table-row>
 <table:table-row><table:table-cell table:number-columns-repeated="9"/></table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>Lee</text:p></table:table-cell>
  <table:table-cell/>
  <table:table-cell office:value-type="string"><text:p>01234</text:p></table:table-cell>
  <table:table-cell table:number-columns-repeated="3"/>
  <table:table-cell table:formula="of:=[.G2]+[.G3]" office:value-type="float" office:value="1.8"><text:p>1.8</text:p></table:table-cell>
  <table:table-cell table:formula="of:=1/0"><text:p>#DIV/0!</text:p></table:table-cell>
  <table:table-cell table:formula="of:=&quot;VIP &quot;&amp;[.A2]" office:value-type="string" office:string-value="VIP Dana"><text:p>VIP Dana</text:p></table:table-cell>
 </table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p><text:s/>Sam<text:s text:c="2"/></text:p></table:table-cell>
 </table:table-row>
</table:table>
<table:table table:name="Archive" table:style-name="ta2">
 <table:table-row><table:table-cell office:value-type="string"><text:p>Not imported</text:p></table:table-cell></table:table-row>
</table:table>
<table:table table:name="Vehicles" table:style-name="ta1">
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>VIN</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Year</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Model</text:p></table:table-cell>
 </table:table-row>
 <table:table-row>
  <table:table-cell office:value-type="string"><text:p>4XASEE57XPA123456</text:p></table:table-cell>
  <table:table-cell office:value-type="float" office:value="2023"><text:p>2023</text:p></table:table-cell>
  <table:table-cell office:value-type="string"><text:p>Sportsman 570</text:p></table:table-cell>
 </table:table-row>
</table:table>
</office:spreadsheet></office:body></office:document>
"""

# A one-line letter, to show a Word document is turned away.
FODT = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:body><office:text><text:p>Customer list to follow.</text:p></office:text></office:body>
</office:document>
"""


def libreoffice(profile):
    """The flat XML above, converted by LibreOffice to .xlsx and .ods, and a
    letter converted to .docx."""
    with tempfile.TemporaryDirectory() as work:
        sources = {"customers-libreoffice.fods": FODS, "letter-libreoffice.fodt": FODT}
        for name, text in sources.items():
            with open(os.path.join(work, name), "w", encoding="utf-8") as file:
                file.write(text)
        out = os.path.join(work, "out")
        for source, target in [("customers-libreoffice.fods", "xlsx"), ("customers-libreoffice.fods", "ods"),
                               ("letter-libreoffice.fodt", "docx")]:
            subprocess.run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless",
                            "--convert-to", target, "--outdir", out, os.path.join(work, source)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        for name in ["customers-libreoffice.xlsx", "customers-libreoffice.ods", "letter-libreoffice.docx"]:
            shutil.copyfile(os.path.join(out, name), os.path.join(HERE, name))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lo-profile", help="LibreOffice profile folder (default: a fresh temporary one)")
    args = parser.parse_args()
    customers_openpyxl()
    dates_1904_openpyxl()
    iso_dates_openpyxl()
    if args.lo_profile:
        libreoffice(os.path.abspath(args.lo_profile))
    else:
        with tempfile.TemporaryDirectory() as profile:
            libreoffice(profile)


if __name__ == "__main__":
    main()
