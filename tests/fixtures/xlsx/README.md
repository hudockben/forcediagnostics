# Workbooks for tests/xlsx.test.ts

Real files from two programs that write .xlsx differently from Excel and from
each other, so the reader in `src/lib/xlsx.ts` is tested against more than
the workbooks the test builds itself. All of them come from
`make-fixtures.py` in this folder, and the test expects exactly what that
script writes: change one and change the other.

To rebuild them (needs openpyxl and LibreOffice's `soffice`):

    python3 tests/fixtures/xlsx/make-fixtures.py

`--lo-profile DIR` picks the LibreOffice profile folder; by default the
script uses a fresh temporary one, so a LibreOffice already open doesn't
lock the conversion. These were made with openpyxl 3.1.5 and LibreOffice
24.2.

| File | Made by | What it covers |
| --- | --- | --- |
| `customers-openpyxl.xlsx` | openpyxl | A customer list. openpyxl writes text as inline strings and leaves out `sharedStrings.xml`; dates and times are numbers with date formats; a formula has no value (openpyxl can't calculate); row 4 is blank; a styled empty cell sits below the data. Also a hidden sheet, a very hidden sheet and a second visible sheet. |
| `dates-1904-openpyxl.xlsx` | openpyxl | Dates counted from 1904 (`workbook.epoch`, written as `date1904="1"`). |
| `iso-dates-openpyxl.xlsx` | openpyxl | Dates as ISO text in `t="d"` cells (`iso_dates = True`), including a time on its own. |
| `customers-libreoffice.xlsx` | LibreOffice | The flat ODS spreadsheet in the script, converted to .xlsx: shared strings, formulas with their results (one is `#DIV/0!`), `t="b"` booleans, escaped format codes such as `yyyy\-mm\-dd\ hh:mm`, `dateCompatibility="false"`, a hidden sheet. |
| `customers-libreoffice.ods` | LibreOffice | The same spreadsheet saved as OpenDocument, which has to be turned away as not an Excel workbook. |
| `letter-libreoffice.docx` | LibreOffice | A one-line Word document, also turned away. |
