import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPin } from "../src/lib/pin-rules";

test("accepts 4–6 digit PINs that aren't obvious", () => {
  for (const pin of ["4829", "7316", "90418", "482916", "3071", "8462"]) {
    assert.equal(checkPin(pin), null, pin);
  }
});

test("rejects wrong lengths and non-digits", () => {
  for (const pin of ["", "123", "1234567", "12a4", " 4829", "48 29"]) {
    assert.notEqual(checkPin(pin), null, pin);
  }
});

test("rejects repeats, runs and evenly stepped PINs", () => {
  for (const pin of ["0000", "999999", "1234", "4321", "0123", "123456", "987654", "1357", "2468", "9630", "0369"]) {
    assert.notEqual(checkPin(pin), null, pin);
  }
});

test("rejects keypad lines, years and common PINs", () => {
  for (const pin of ["2580", "0852", "1590", "3570", "1985", "2024", "1212", "1004", "6969", "121212", "123123", "112233", "147258", "159753"]) {
    assert.notEqual(checkPin(pin), null, pin);
  }
});
