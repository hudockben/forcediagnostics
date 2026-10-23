"use client";

import { useEffect, useId, useState } from "react";

import { inputBaseClass } from "@/components/hud";
import type { UnitSuggestion } from "@/lib/diagnose-rules";

import { suggestUnitsAction } from "./actions";

// A model number box that suggests units from the shop's model list as the
// tech types ("2019 RZR XP 1000 EPS — Z19VDE99AM"), by model number or by
// words of the model name.
export function UnitPicker({
  id,
  value,
  onChange,
  picked,
  onPick,
  placeholder = "Z19VDE99AM, or RZR XP 1000",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  picked: UnitSuggestion | null;
  onPick: (suggestion: UnitSuggestion | null) => void;
  placeholder?: string;
}) {
  const listId = useId();
  const [found, setFound] = useState<{ query: string; items: UnitSuggestion[] }>({ query: "", items: [] });
  const [focused, setFocused] = useState(false);
  const query = value.trim();

  useEffect(() => {
    if (query.length < 2 || picked?.modelNumber === query.toUpperCase()) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const items = await suggestUnitsAction(query);
      if (!cancelled) setFound({ query, items });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, picked]);

  const items = found.query === query && !picked ? found.items : [];
  const open = focused && items.length > 0;

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          if (picked) onPick(null);
        }}
        onFocus={() => setFocused(true)}
        // Long enough for a tap on a suggestion to land first.
        onBlur={() => setTimeout(() => setFocused(false), 200)}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={60}
        className={inputBaseClass}
      />
      {picked && <p className="mt-1.5 text-xs text-glow">{picked.label} · {picked.manuals} {picked.manuals === 1 ? "manual" : "manuals"}</p>}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching units"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-white/10 bg-charcoal-900 shadow-xl shadow-black/50"
        >
          {items.map((item) => (
            <li key={`${item.modelNumber}|${item.year}|${item.description}`} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(item.modelNumber);
                  onPick(item);
                  setFocused(false);
                }}
                className="flex min-h-12 w-full flex-col items-start justify-center px-3.5 py-2 text-left text-sm hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
              >
                <span className="text-ink">{item.label}</span>
                <span className="text-xs text-ink-muted">
                  {item.manuals} {item.manuals === 1 ? "manual" : "manuals"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
