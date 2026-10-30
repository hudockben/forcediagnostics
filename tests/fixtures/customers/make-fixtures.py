# Builds customers.xlsx for tests/customer-import.test.ts: a dealer-style
# export with a title row above the headings, a mobile and a home phone
# column, a ZIP code Excel stored as a number (its leading zero lost), real
# Excel dates, and one customer on two rows (two vehicles). Run with
# python3 make-fixtures.py (needs openpyxl).
import datetime

import openpyxl

book = openpyxl.Workbook()
sheet = book.active
sheet.title = "Customers"
sheet.append(["Customer list - printed 10/30/2026"])
sheet.append([])
sheet.append(["First Name", "Last Name", "Home Phone", "Mobile", "E-mail Address", "Address", "City", "State", "Zip",
              "Deal Type", "Purchase Date", "Year", "Make", "Model", "Model #", "VIN"])
rows = [
    ["Dana", "Whitfield", "814-555-0100", 8145550199, "dana@example.com", "412 Logan Blvd", "Altoona", "PA", 16602,
     "New", datetime.date(2024, 6, 24), 2021, "Polaris", "Sportsman 850", "A21SXZ85A1", None],
    ["Dana", "Whitfield", None, 8145550199, None, None, None, None, None,
     "Trade-In", datetime.date(2024, 6, 24), 2016, "Polaris", "Ranger 570", None, None],
    ["Ana", "Ruiz", None, "(617) 555-0142", "ANA@EXAMPLE.COM", "9 Elm St", "Boston", "MA", 2134,
     "Service", None, 2019, "Polaris", "RZR XP 1000", "Z19VDE99AM", None],
    [None, None, None, None, None, None, None, None, None, None, None, None, None, None, None, None],
    [None, None, "555-0100", None, None, None, None, None, None, None, None, None, None, None, None, None],
]
for row in rows:
    sheet.append(row)
sheet["K4"].number_format = "m/d/yyyy"
sheet["K5"].number_format = "m/d/yyyy"
book.save("customers.xlsx")
