"use client";

import { useEffect, useRef, useState } from "react";

import { Notice } from "@/components/app/ui";
import { inputBaseClass, labelClass } from "@/components/hud";
import { DIAGNOSE_LIMITS } from "@/lib/diagnose-rules";
import { useFormAction } from "@/lib/use-form-action";

import { deleteConversationAction } from "./actions";

const deleteButtonClass =
  "h-12 rounded-lg border border-trail/50 px-4 text-base font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none disabled:opacity-60";

// Delete diagnosis, for managers and admins signed in with a password. It
// asks first, with a box for why, which the Activity log keeps with what
// the diagnosis was. Not while Claude is answering (the server refuses that
// too); afterwards the server sends the page on to the list.
export function DeleteDiagnosis({ conversation, busy }: { conversation: { id: string; title: string }; busy: boolean }) {
  const { state, pending, formProps } = useFormAction<{ error?: string }>(deleteConversationAction, {});
  const [confirming, setConfirming] = useState(false);
  // Set by Cancel, so focus goes back to the button that opened the step.
  const returnFocus = useRef(false);
  const openButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      openButton.current?.focus();
    }
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        ref={openButton}
        type="button"
        onClick={() => setConfirming(true)}
        data-delete-diagnosis
        className="inline-flex min-h-11 items-center rounded-lg border border-trail/40 px-4 text-sm font-medium text-trail transition hover:bg-trail/10 focus-visible:ring-2 focus-visible:ring-trail/40 focus-visible:outline-none"
      >
        Delete diagnosis
      </button>
    );
  }
  return (
    <form {...formProps} aria-label="Delete this diagnosis" className="space-y-3 rounded-xl border border-trail/40 bg-trail/5 p-4">
      <input type="hidden" name="conversationId" value={conversation.id} />
      <p id="delete-question" className="text-sm leading-6 text-ink">
        Delete “{conversation.title}” and all its messages? This can&apos;t be undone. The Activity log keeps a record of what it
        was, and that you deleted it.
      </p>
      <div>
        <label htmlFor="delete-reason" className={labelClass}>
          Why <span className="font-normal text-ink-muted">(optional, kept in the Activity log)</span>
        </label>
        <input
          id="delete-reason"
          name="reason"
          maxLength={DIAGNOSE_LIMITS.deleteReason}
          autoComplete="off"
          // Focus moves into the step the user just opened.
          autoFocus
          aria-describedby="delete-question"
          placeholder="Started by mistake, a test, a duplicate…"
          className={`mt-1.5 ${inputBaseClass}`}
        />
      </div>
      {state.error && <Notice tone="trail">{state.error}</Notice>}
      {busy && <p className="text-sm text-ink-muted">Claude is answering a message. Stop it, or wait for it to finish, to delete.</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={pending || busy} className={`${deleteButtonClass} flex-1`}>
          {pending ? "Deleting…" : "Yes, delete it"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            returnFocus.current = true;
            setConfirming(false);
          }}
          className="h-12 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
