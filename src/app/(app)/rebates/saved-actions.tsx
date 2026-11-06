"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { removeSavedInvoiceAction } from "./actions";
import { REMOVED_EVENT } from "./rebates";

// Saved rebates' buttons for an invoice: Open (onto the page above, to
// change and save again) and Remove.

const linkClass = "text-sm font-medium text-glow/90 hover:text-glow hover:underline focus-visible:underline focus-visible:outline-none";

// Opens a saved invoice on the page (?open=, which the page loads). One on
// the page already is just scrolled to.
export function OpenInvoiceLink({ id, href, label }: { id: string; href: string; label: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      onClick={(event) => {
        const card = document.querySelector(`[data-rebates-card="${id}"]`);
        if (!card) return;
        event.preventDefault();
        card.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
      className={linkClass}
      data-rebates-open={id}
    >
      Open<span className="sr-only"> {label}</span>
    </Link>
  );
}

// Removes a saved invoice and its lines, asking first. The page comes back
// without it, saying which went.
export function RemoveInvoice({ id, label, lines }: { id: string; label: string; lines: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removeButton = useRef<HTMLButtonElement>(null);

  async function remove() {
    setPending(true);
    setError(null);
    const result = await removeSavedInvoiceAction(id).catch(() => ({ error: "The connection dropped. Check it, then try again." }));
    if ("error" in result) {
      setPending(false);
      setError(result.error);
      return;
    }
    window.dispatchEvent(new CustomEvent(REMOVED_EVENT, { detail: id }));
    const params = new URLSearchParams(window.location.search);
    if (params.get("open") === id) params.delete("open");
    params.set("removed", label);
    router.replace(`/rebates?${params}`, { scroll: false });
  }

  if (!confirming) {
    return (
      <button ref={removeButton} type="button" onClick={() => setConfirming(true)} className="text-sm text-trail/90 hover:text-trail hover:underline focus-visible:underline focus-visible:outline-none" data-rebates-remove={id}>
        Remove<span className="sr-only"> {label}</span>
      </button>
    );
  }
  const question = `rebates-remove-${id}`;
  return (
    <div className="max-w-64 space-y-2 text-left">
      <p id={question} className="text-xs leading-5 text-ink">
        Remove {label} and its {lines === 1 ? "line" : `${lines.toLocaleString("en-US")} lines`} from Saved rebates? The Activity log keeps a record of it.
      </p>
      {error && (
        <p role="alert" className="text-xs text-trail">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void remove()}
          disabled={pending}
          autoFocus
          aria-describedby={question}
          className="inline-flex min-h-9 items-center rounded-lg border border-trail/50 px-3 text-sm font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60"
          data-rebates-remove-yes
        >
          {pending ? "Removing…" : "Yes, remove"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setError(null);
            requestAnimationFrame(() => removeButton.current?.focus());
          }}
          className="min-h-9 text-sm text-ink-muted hover:text-ink focus-visible:underline focus-visible:outline-none"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
