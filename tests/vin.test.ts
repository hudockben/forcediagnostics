// VINs for Diagnose: normalising and checking what the tech types, the
// North American check digit, the model year code, and matching a VIN to
// Polaris model numbers (characters 4-8 are the same model code; a model
// number's 2-3 are the year). The model numbers and descriptions here are
// real ones from Polaris's model list.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  VIN_CHECK_DIGIT_WARNING,
  checkVin,
  isVin,
  normalizeVin,
  sharedModelName,
  vinCheckDigit,
  vinMatchesModelNumber,
  vinModelCode,
  vinModelNumberPatterns,
  vinYears,
} from "../src/lib/vin";

// The check digit worked out for each (see vinCheckDigit).
const SPORTSMAN_2023 = "4XASEE578PA123456"; // A23SEE57.. : 2023 Sportsman 570 EPS
const RZR_2019 = "3NSVDE994KF123456"; // Z19VDE99.. : 2019 RZR XP 1000

// A LIKE pattern as Postgres reads it: _ is any one character, % anything.
const like = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/_/g, ".").replace(/%/g, ".*")}$`).test(value);

describe("VINs", () => {
  test("what's typed is upper-cased, without spaces and dashes", () => {
    assert.equal(normalizeVin(" 4xa-see57 8pa 123456 "), SPORTSMAN_2023);
    assert.equal(normalizeVin("4XA–SEE578PA123456"), SPORTSMAN_2023);
    assert.equal(normalizeVin(""), "");
  });

  test("the check digit is worked out as 49 CFR 565 does it", () => {
    // The textbook example, whose check digit is X.
    assert.equal(vinCheckDigit("1M8GDM9AXKP042788"), "X");
    assert.equal(vinCheckDigit(SPORTSMAN_2023), "8");
    assert.equal(vinCheckDigit(RZR_2019), "4");
    assert.equal(vinCheckDigit("4XASEE57"), null);
    assert.equal(vinCheckDigit("4XASEE57OPA123456"), null);
  });

  test("a VIN is 17 letters and digits without I, O or Q; a wrong check digit is only a warning", () => {
    assert.deepEqual(checkVin(""), { status: "empty" });
    assert.deepEqual(checkVin("  "), { status: "empty" });
    assert.deepEqual(checkVin(SPORTSMAN_2023.toLowerCase()), { status: "ok", vin: SPORTSMAN_2023, checkDigitOk: true, warning: null });
    // One character misread: still a VIN, with a warning.
    const off = checkVin("4XASEE578PA123465");
    assert.equal(off.status, "ok");
    assert.ok(off.status === "ok" && !off.checkDigitOk);
    assert.ok(off.status === "ok" && off.warning === VIN_CHECK_DIGIT_WARNING);
    assert.match(VIN_CHECK_DIGIT_WARNING, /check the VIN.*a character may be off/i);
    // The last 6-8 digits techs sometimes have aren't a VIN.
    for (const partial of ["123456", "PA123456", "A123456"]) {
      const result = checkVin(partial);
      assert.equal(result.status, "partial", partial);
      assert.ok(result.status === "partial" && /a VIN has 17/.test(result.message) && /don't say which model/.test(result.message));
    }
    const letters = checkVin("4XASEE57OPA12345I");
    assert.equal(letters.status, "invalid");
    assert.ok(letters.status === "invalid" && /I, O or Q/.test(letters.message));
    assert.equal(checkVin("4XASEE578PA1234567").status, "invalid");
    assert.equal(checkVin("4XASEE578PA12345#").status, "invalid");
    assert.ok(isVin(SPORTSMAN_2023));
    assert.ok(!isVin(SPORTSMAN_2023.toLowerCase()));
    assert.ok(!isVin("123456"));
  });

  test("character 10 is the model year, which repeats every 30 years", () => {
    assert.deepEqual(vinYears(SPORTSMAN_2023, 2028), [2023, 1993]);
    assert.deepEqual(vinYears(RZR_2019, 2028), [2019, 1989]);
    // 2009 (9) and 2001 (1) have no second year yet; 2028 (W) does.
    assert.deepEqual(vinYears("3NSVDE9949F123456", 2028), [2009]);
    assert.deepEqual(vinYears("3NSVDE994WF123456", 2028), [2028, 1998]);
    assert.deepEqual(vinYears("3NSVDE994WF123456", 2027), [1998]);
    // U, Z and 0 are never years.
    for (const code of ["U", "Z", "0"]) assert.deepEqual(vinYears(`3NSVDE994${code}F123456`, 2028), []);
    assert.equal(vinModelCode(SPORTSMAN_2023), "SEE57");
  });

  test("a VIN matches the model numbers with its code in characters 4-8 and its year in 2-3, any first letter", () => {
    assert.deepEqual(vinModelNumberPatterns(SPORTSMAN_2023, 2028), [
      { year: 2023, pattern: "_23SEE57%" },
      { year: 1993, pattern: "_93SEE57%" },
    ]);
    const [pattern] = vinModelNumberPatterns(SPORTSMAN_2023, 2028);
    // Every 2023 Sportsman 570 EPS variant, whatever its paint or market.
    for (const number of ["A23SEE57A1", "A23SEE57A9", "A23SEE57B9", "A23SEE57K2", "A23SEE57PL"]) {
      assert.ok(like(pattern.pattern, number), number);
      assert.ok(vinMatchesModelNumber(SPORTSMAN_2023, number, 2028), number);
    }
    // Not the carbureted 570, a Touring, or another year.
    for (const number of ["A23SEA57A1", "A23SDE57A4", "A22SEE57A1", "A24SEE57A1"]) {
      assert.ok(!vinModelNumberPatterns(SPORTSMAN_2023, 2028).some((p) => like(p.pattern, number)), number);
      assert.ok(!vinMatchesModelNumber(SPORTSMAN_2023, number, 2028), number);
    }
    assert.ok(vinMatchesModelNumber(RZR_2019, "Z19VDE99AM", 2028));
    assert.ok(vinMatchesModelNumber(RZR_2019, "z19vde99ak", 2028));
    assert.ok(!vinMatchesModelNumber(RZR_2019, "Z20VDE99AM", 2028));
    // The first RZR 800s are listed under Ranger and RZR letters both.
    assert.ok(vinMatchesModelNumber("3NSVE7EA4EF123456", "R14VE7EAL", 2028));
    assert.ok(vinMatchesModelNumber("3NSVE7EA4EF123456", "Z14VE7EAJ", 2028));
    // Model numbers from before 1997 have a four-character code (P937221):
    // no VIN matches them, and that's said rather than guessed.
    assert.ok(!vinMatchesModelNumber("4XAW86274PA123456", "P937221", 2028));
    // A model number with I in its code (R17RMAI4G8) can't be a VIN's: a
    // VIN with that code isn't a VIN.
    assert.equal(checkVin("3NSRMAI44HA123456").status, "invalid");
  });

  test("the name several variants share leaves out their paint", () => {
    assert.equal(
      sharedModelName([
        "SPORTSMAN 570 EPS - SAGE GREEN",
        "SPORTSMAN 570 EPS - POLARIS PURSUIT CAMO",
        "SPORTSMAN 570 EPS GREEN EU",
        "SPORTSMAN 570 EPS ONXY BLACK (3PC)",
      ]),
      "SPORTSMAN 570 EPS",
    );
    assert.equal(
      sharedModelName(["RZR 64 XP 1000 EPS - BLACK PEARL", "RZR XP 1000 BLACK PEARL", "RZR XP 1000 SKY BLUE"]),
      "RZR XP 1000",
    );
    assert.equal(sharedModelName(["RZR XP 1000 WHITE PEARL"]), "RZR XP 1000 WHITE PEARL");
    // Nothing in common: the first one's name before its paint.
    assert.equal(sharedModelName(["TRAILBLAZER", "SPORT 400L"]), "TRAILBLAZER");
    assert.equal(sharedModelName([null, ""]), null);
  });
});
