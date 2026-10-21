// PIN rules for bay tablets. No server imports, so forms can check as people type.

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

const PIN_PATTERN = /^\d{4,6}$/;

// Lines on a phone-style keypad (rows, columns, diagonals) in either direction.
const KEYPAD_LINES = ["123", "456", "789", "147", "258", "369", "2580", "159", "357"];

// Common PINs the other rules don't already catch.
const COMMON = new Set([
  "1212", "1004", "2000", "6969", "1122", "1313", "4444", "2001", "1010", "2222",
  "1112", "1231", "1123", "1221", "2121", "1414", "1515", "1001", "0007", "7777",
  "0101", "1020", "1024", "2468", "1357", "4545", "5150", "1066", "0911", "0707",
  "121212", "123123", "112233", "696969", "147258", "159753", "123321", "654321",
  "111222", "000007", "131313", "252525", "101010", "202020", "007007", "520520",
]);

const reversed = (s: string) => [...s].reverse().join("");

// Returns why a PIN can't be used, or null if it's fine. Wrong PINs lock after
// a few tries, so the first guesses anyone would make are not allowed.
export function checkPin(pin: string): string | null {
  if (!PIN_PATTERN.test(pin)) return `PINs are ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits.`;

  const tooCommon = "That PIN is too easy to guess. Pick another.";
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  // Repeats and evenly stepped runs: 1111, 1234, 4321, 1357, 2468, 9630.
  if (steps.every((s) => s === steps[0])) return tooCommon;
  // Keypad lines such as 2580, 1590 or 0951, forwards or backwards, with at
  // most one digit before or after.
  for (const line of KEYPAD_LINES) {
    if (pin.length > line.length + 1) continue;
    for (const run of [line, reversed(line)]) {
      if (pin.startsWith(run) || pin.endsWith(run)) return tooCommon;
    }
  }
  // Years people use: 1940–2039.
  if (pin.length === 4 && Number(pin) >= 1940 && Number(pin) <= 2039) return tooCommon;
  // Six digits made of a repeated pair or triple: 121212, 123123, 112233.
  if (pin.length === 6) {
    const pairs = pin.match(/../g)!;
    if (pairs.every((p) => p === pairs[0])) return tooCommon;
    if (pin.slice(0, 3) === pin.slice(3)) return tooCommon;
    if (pairs.every((p) => p[0] === p[1])) return tooCommon;
  }
  if (COMMON.has(pin)) return tooCommon;
  return null;
}
