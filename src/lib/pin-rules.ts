// PIN rules for bay tablets. No server imports, so forms can check as people type.

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

const PIN_PATTERN = /^\d{4,6}$/;

// Returns why a PIN can't be used, or null if it's fine. Wrong PINs lock after
// a few tries, so the first guesses anyone would make are not allowed.
export function checkPin(pin: string): string | null {
  if (!PIN_PATTERN.test(pin)) return `PINs are ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits.`;
  if (/^(\d)\1+$/.test(pin)) return "Pick a PIN that isn't the same digit repeated.";
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return "Pick a PIN that isn't a run like 1234 or 4321.";
  }
  return null;
}
