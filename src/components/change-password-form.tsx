"use client";

import { useState, type FormEvent } from "react";

import { labelClass, secondaryButtonClass } from "@/components/hud";
import { PasswordInput } from "@/components/password-input";
import { authClient } from "@/lib/auth-client";

const MESSAGES: Record<string, string> = {
  INVALID_PASSWORD: "Your current password is wrong.",
  PASSWORD_TOO_SHORT: "The new password must be at least 8 characters.",
  PASSWORD_TOO_LONG: "The new password is too long.",
};

export function ChangePasswordForm() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get("newPassword"));
    if (newPassword !== String(form.get("confirmPassword"))) {
      setNotice("The new passwords don't match.");
      return;
    }

    setPending(true);
    setNotice(null);
    const { error } = await authClient.changePassword({
      currentPassword: String(form.get("currentPassword")),
      newPassword,
      // Sign out anywhere else this account is signed in.
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) {
      setNotice(
        error.status === 429
          ? "Too many attempts. Wait a minute, then try again."
          : (MESSAGES[error.code ?? ""] ?? "Couldn't change your password. Try again."),
      );
      return;
    }
    formElement.reset();
    setOpen(false);
    setNotice("Password changed.");
  }

  if (!open) {
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)} className={secondaryButtonClass}>
          Change password
        </button>
        <p role="status" className="mt-3 text-sm text-glow empty:hidden">
          {notice}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {[
        { id: "currentPassword", label: "Current password", autoComplete: "current-password" },
        { id: "newPassword", label: "New password", autoComplete: "new-password" },
        { id: "confirmPassword", label: "Confirm new password", autoComplete: "new-password" },
      ].map((field) => (
        <div key={field.id}>
          <label htmlFor={field.id} className={labelClass}>
            {field.label}
          </label>
          <PasswordInput
            id={field.id}
            name={field.id}
            required
            minLength={field.id === "currentPassword" ? undefined : 8}
            autoComplete={field.autoComplete}
          />
        </div>
      ))}
      <div className="flex gap-3">
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          {pending ? "Saving…" : "Save new password"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setNotice(null);
          }}
          className="h-12 shrink-0 rounded-lg px-4 text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-glow/40 focus-visible:outline-none"
        >
          Cancel
        </button>
      </div>
      <p role="status" className="text-sm leading-5 text-trail empty:hidden">
        {notice}
      </p>
    </form>
  );
}
