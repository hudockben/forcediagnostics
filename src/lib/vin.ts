// Vehicle identification numbers, for Diagnose's quick form and unit
// lookups. Pure, so the browser checks a VIN as it's typed with the same
// rules the server applies.
//
// A VIN is 17 letters and digits, never I, O or Q (they'd pass for 1 and 0).
// North American VINs carry a check digit in character 9, worked out from
// the other 16 (49 CFR 565): a mismatch usually means a character was
// misread, so it's a warning, not a refusal. Character 10 is the model year,
// in a code that repeats every 30 years (P is 1993 and 2023).
//
// Polaris VINs carry the model code in characters 4-8, the same five
// characters as 4-8 of Polaris's model numbers, whose characters 2-3 are the
// two-digit model year: model number Z19VDE99AM and a VIN 3NSVDE99_K... (K is
// 2019), A23SEE57A1 and 4XASEE57_P... (P is 2023). Checked against Polaris's
// whole model list: every model number from 1997 on is a letter, the year's
// two digits and five more characters (then up to two for paint and market),
// and the year digits match the list's Year column for 99.7% of entries.
// Older model numbers (W928627, 1985-1996) have a four-character code, so
// those VINs don't match. The paint and options (a model number's last
// characters) aren't in the VIN, so a VIN finds the model's variants, all of
// them.

export const VIN_LENGTH = 17;

// Transliteration for the check digit.
const VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Model year codes from 1980 (A) to 2009 (9); the same letters come round
// again from 2010.
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";
const FIRST_YEAR = 1980;

// " 4xa-see57 xpa 123456 " -> "4XASEE57XPA123456": upper-cased, without the
// spaces and dashes people type or copy with it. A label in front ("VIN:
// 4XA…", "VIN# 4XA…", "VIN 4XA…", copied from a work order) goes too, and so
// does the leading I a barcode scanner reads off a Code 39 VIN label (18
// characters): no VIN has an I in it, so neither can be part of one.
export function normalizeVin(text: string) {
  let vin = String(text ?? "")
    .toUpperCase()
    .replace(/[\s\-‐-―]+/g, "")
    .replace(/^VIN(?:NO|NUMBER)?[.:#]*/, "");
  if (vin.length === VIN_LENGTH + 1 && vin.startsWith("I")) vin = vin.slice(1);
  return vin;
}

// The check digit a 17-character VIN should have ("0"-"9" or "X"), or null
// when it has a character a VIN can't.
export function vinCheckDigit(vin: string): string | null {
  if (vin.length !== VIN_LENGTH) return null;
  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i++) {
    const value = VALUES[vin[i]];
    if (value === undefined) return null;
    sum += value * WEIGHTS[i];
  }
  const digit = sum % 11;
  return digit === 10 ? "X" : String(digit);
}

// The model years character 10 can mean, newest first, up to maxYear (model
// years run a year or so ahead of the calendar).
export function vinYears(vin: string, maxYear = new Date().getUTCFullYear() + 2): number[] {
  const index = YEAR_CODES.indexOf(vin[9] ?? "");
  if (index < 0) return [];
  const years: number[] = [];
  for (let year = FIRST_YEAR + index; year <= maxYear; year += 30) years.unshift(year);
  return years;
}

// Characters 4-8: the model code.
export const vinModelCode = (vin: string) => vin.slice(3, 8);

export type VinCheck =
  | { status: "empty" }
  // Not a VIN: too short (often the last 6-8 characters, the serial
  // number), too long, or with characters a VIN never has. message says why.
  | { status: "partial" | "invalid"; vin: string; message: string }
  // A VIN. checkDigitOk is false when character 9 doesn't match the rest
  // (warning says so); it's still used.
  | { status: "ok"; vin: string; checkDigitOk: boolean; warning: string | null };

// From this many characters a short VIN is a whole one with something
// missing rather than its end (the last 6-8 characters are the serial).
const PARTIAL_NEARLY_WHOLE = 12;

export const VIN_CHECK_DIGIT_WARNING =
  "Check the VIN: its check digit (the 9th character) doesn't match the rest, so a character may be off.";

// What the quick form says about what's in its VIN box, and what the server
// accepts: nothing, or a 17-character VIN.
export function checkVin(text: string): VinCheck {
  const vin = normalizeVin(text);
  if (!vin) return { status: "empty" };
  if (/[IOQ]/.test(vin) && /^[A-Z0-9]+$/.test(vin)) {
    return {
      status: "invalid",
      vin,
      message: "A VIN never has the letters I, O or Q (they'd be read as 1 and 0). Check those characters.",
    };
  }
  if (!/^[A-Z0-9]+$/.test(vin)) {
    return { status: "invalid", vin, message: "A VIN is only letters and digits." };
  }
  if (vin.length < VIN_LENGTH) {
    const count = `That's ${vin.length} ${vin.length === 1 ? "character" : "characters"}: a VIN has ${VIN_LENGTH}.`;
    return {
      status: "partial",
      vin,
      // Nearly all of it: a character or two left out. Much less: the
      // serial number at its end, which techs sometimes have on their own.
      message:
        vin.length >= PARTIAL_NEARLY_WHOLE
          ? `${count} ${VIN_LENGTH - vin.length === 1 ? "A character is" : `${VIN_LENGTH - vin.length} characters are`} missing: check it against the frame.`
          : `${count} The last few digits alone are the serial number and don't say which model it is.`,
    };
  }
  if (vin.length > VIN_LENGTH) {
    return { status: "invalid", vin, message: `That's ${vin.length} characters: a VIN has ${VIN_LENGTH}.` };
  }
  const checkDigitOk = vinCheckDigit(vin) === vin[8];
  return { status: "ok", vin, checkDigitOk, warning: checkDigitOk ? null : VIN_CHECK_DIGIT_WARNING };
}

// A stored VIN, as the screen shows it: only a 17-character VIN counts.
export function isVin(value: unknown): value is string {
  return typeof value === "string" && checkVin(value).status === "ok" && normalizeVin(value) === value;
}

// The LIKE patterns for the model numbers a VIN can be: any first letter,
// the model year's two digits, then the model code (`_23SEE57%`), one for
// each year character 10 can mean, newest first.
export function vinModelNumberPatterns(vin: string, maxYear?: number): { year: number; pattern: string }[] {
  const code = vinModelCode(vin);
  if (!/^[A-HJ-NPR-Z0-9]{5}$/.test(code)) return [];
  return vinYears(vin, maxYear).map((year) => ({ year, pattern: `_${String(year % 100).padStart(2, "0")}${code}%` }));
}

// Whether a model number is one a VIN can be (same model code, a year
// character 10 can mean).
export function vinMatchesModelNumber(vin: string, modelNumber: string, maxYear?: number) {
  const number = modelNumber.toUpperCase();
  if (number.length < 8) return false;
  return vinModelNumberPatterns(vin, maxYear).some(
    ({ pattern }) => number.slice(1, 3) === pattern.slice(1, 3) && number.slice(3, 8) === pattern.slice(3, 8),
  );
}

// The name several models share, for a VIN that matches a model's variants
// ("SPORTSMAN 570 EPS - SAGE GREEN", "SPORTSMAN 570 EPS GREEN EU" ->
// "SPORTSMAN 570 EPS"): the words every description has, in the first one's
// order, after leaving out the paint Polaris writes after " - ". Failing that
// (no word in common), the first description's name before its paint. When
// they all have the same description, that description, paint and all.
export function sharedModelName(descriptions: (string | null)[]): string | null {
  const given = descriptions.filter((text): text is string => typeof text === "string" && text.trim() !== "");
  // Variants listed under one description (A and B market versions, say)
  // share its paint too.
  const distinct = new Set(given.map((text) => text.trim().replace(/\s+/g, " ").toUpperCase()));
  if (distinct.size === 1) return [...distinct][0];
  const names = given.map((text) => text.split(/\s+-\s+/)[0].trim());
  if (names.length === 0) return null;
  const words = (name: string) => name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const [first, ...rest] = names.map(words);
  const others = rest.map((list) => new Set(list));
  const shared = first.filter((word) => others.every((set) => set.has(word)));
  return shared.some((word) => /[A-Z]/.test(word)) ? shared.join(" ") : names[0].toUpperCase();
}

// A model number's year, from its characters 2-3 (1997 on: A23SEE57A1 is
// 2023, W98AE50A 1998); null for an older or odd one, which a VIN can't be
// compared with.
export function modelNumberYear(modelNumber: string): number | null {
  const match = /^[A-Z](\d\d)[A-HJ-NPR-Z0-9]{5}/.exec(modelNumber.toUpperCase().replace(/\s+/g, ""));
  if (!match) return null;
  const yy = Number(match[1]);
  return yy >= 80 ? 1900 + yy : 2000 + yy;
}

// What the screen says when a VIN and a model number given for the same
// unit are for different models (their codes in characters 4-8, or their
// years, differ), or null when they agree or can't be compared (a model
// number from before 1997, or something that isn't one). The VIN's year is
// the one that fits the model number's, or else the newest that isn't in
// the future.
export function vinDisagreement(vin: string, modelNumber: string, thisYear = new Date().getUTCFullYear()): string | null {
  const number = modelNumber.toUpperCase().replace(/\s+/g, "");
  const numberYear = modelNumberYear(number);
  if (numberYear === null || checkVin(vin).status !== "ok") return null;
  if (vinMatchesModelNumber(vin, number)) return null;
  const years = vinYears(vin);
  const year = years.find((candidate) => candidate === numberYear) ?? years.find((candidate) => candidate <= thisYear + 1) ?? years.at(-1);
  return `This VIN reads as ${year ? `a ${year}, ` : ""}model code ${vinModelCode(vin)}; ${number} is a ${numberYear}, model code ${number.slice(3, 8)}. One of them may be off: check both on the frame.`;
}
