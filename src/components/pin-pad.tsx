"use client";

import { useEffect, useRef } from "react";

import { PIN_MAX_LENGTH } from "@/lib/pin-rules";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

const keyClass =
  "flex h-16 items-center justify-center rounded-xl border border-white/10 bg-forest-950/70 text-2xl font-medium text-ink transition select-none active:bg-glow/20 hover:border-glow/40 focus-visible:ring-2 focus-visible:ring-glow/50 focus-visible:outline-none disabled:opacity-50";

// Big-button number pad for entering a PIN with gloves or dirty hands. Digits
// typed on a keyboard work too. Shows dots, never the digits.
export function PinPad({
  value,
  onChange,
  onSubmit,
  disabled,
  submitLabel = "Enter",
  minLength,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitLabel?: string;
  minLength: number;
}) {
  const latest = useRef({ value, onChange, onSubmit, disabled, minLength });
  useEffect(() => {
    latest.current = { value, onChange, onSubmit, disabled, minLength };
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const { value, onChange, onSubmit, disabled, minLength } = latest.current;
      if (disabled || event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^\d$/.test(event.key)) {
        if (value.length < PIN_MAX_LENGTH) onChange(value + event.key);
        event.preventDefault();
      } else if (event.key === "Backspace") {
        onChange(value.slice(0, -1));
        event.preventDefault();
      } else if (event.key === "Enter" && value.length >= minLength) {
        onSubmit();
        event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const press = (digit: string) => {
    if (value.length < PIN_MAX_LENGTH) onChange(value + digit);
  };

  return (
    <div className="space-y-5">
      <div
        className="flex h-6 items-center justify-center gap-3"
        role="img"
        aria-label={`${value.length} digit${value.length === 1 ? "" : "s"} entered`}
      >
        {Array.from({ length: PIN_MAX_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`size-3.5 rounded-full border transition ${
              i < value.length ? "border-glow bg-glow" : "border-white/25"
            }`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={disabled}
            onClick={() => press(digit)}
            className={keyClass}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
          aria-label="Delete last digit"
          className={`${keyClass} text-lg text-ink-muted`}
        >
          ⌫
        </button>
        <button type="button" disabled={disabled} onClick={() => press("0")} className={keyClass}>
          0
        </button>
        <button
          type="button"
          disabled={disabled || value.length < minLength}
          onClick={onSubmit}
          className={`${keyClass} border-trail/40 bg-trail text-base font-semibold text-charcoal-900 hover:border-trail active:bg-trail-bright`}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
