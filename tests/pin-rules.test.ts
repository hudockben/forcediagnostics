import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPin } from "../src/lib/pin-rules";

test("accepts 4–6 digit PINs that aren't obvious", () => {
  for (const pin of ["2580", "1357", "90210", "482916", "1123", "0912"]) {
    assert.equal(checkPin(pin), null, pin);
  }
});

test("rejects wrong lengths and non-digits", () => {
  for (const pin of ["", "123", "1234567", "12a4", " 2580", "25 80"]) {
    assert.notEqual(checkPin(pin), null, pin);
  }
});

test("rejects repeated digits and straight runs", () => {
  for (const pin of ["0000", "1111", "999999", "1234", "4321", "0123", "6789", "123456", "987654"]) {
    assert.notEqual(checkPin(pin), null, pin);
  }
});
