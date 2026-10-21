"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { HudCard, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { PinPad } from "@/components/pin-pad";
import { authClient } from "@/lib/auth-client";
import { PIN_MIN_LENGTH } from "@/lib/pin-rules";
import { describeWarning, signInWithPin } from "@/lib/pin-sign-in";

type Person = { id: string; name: string; username: string; locked: boolean };

// A half-typed PIN is cleared, and the name list comes back, after this long.
const PIN_IDLE_MS = 60 * 1000;

const goHome = () => window.location.replace("/home");

export function BayPicker({
  deviceName,
  people,
  endLeftoverSession,
}: {
  deviceName: string;
  people: Person[];
  endLeftoverSession: boolean;
}) {
  const [person, setPerson] = useState<Person | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const lastTouch = useRef(0);
  const touch = useCallback(() => {
    lastTouch.current = Date.now();
  }, []);
  const [signOutFailed, setSignOutFailed] = useState(false);

  // If someone is still signed in on this browser (an idle lock that
  // couldn't reach the server, say), end that session first.
  useEffect(() => {
    if (!endLeftoverSession) return;
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        const ok = await authClient
          .signOut()
          .then(({ error }) => !error)
          .catch(() => false);
        if (ok) return;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (!cancelled) setSignOutFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [endLeftoverSession]);

  useEffect(() => {
    if (!person) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastTouch.current > PIN_IDLE_MS) {
        setPerson(null);
        setPin("");
        setMessage(null);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [person]);

  function choose(next: Person) {
    setPerson(next);
    setPin("");
    setMessage(null);
    touch();
  }

  async function submit() {
    if (!person) return;
    setPending(true);
    setMessage(null);
    const result = await signInWithPin(person.id, pin);
    setPin("");
    if (result.ok) {
      if (result.warning) {
        setWarning(describeWarning(result.warning));
        setPending(false);
      } else {
        goHome();
      }
      return;
    }
    setPending(false);
    if (result.notATablet) window.location.reload();
    setMessage(result.message);
  }

  if (warning) {
    return (
      <HudCard eyebrow={deviceName} title="Heads up" titleId="bay-heading">
        <p role="alert" className="mt-4 text-base leading-7 text-trail">
          {warning}
        </p>
        <button type="button" onClick={goHome} className={`${primaryButtonClass} mt-6`}>
          Continue
        </button>
      </HudCard>
    );
  }

  if (person) {
    return (
      <HudCard eyebrow={deviceName} title={person.name} titleId="bay-heading">
        <p className="mt-1 font-mono text-sm text-ink-muted">{person.username}</p>
        <div className="mt-6" onPointerDown={touch}>
          <PinPad
            value={pin}
            onChange={(value) => {
              setPin(value);
              setMessage(null);
              touch();
            }}
            onSubmit={submit}
            disabled={pending}
            submitLabel={pending ? "…" : "Enter"}
            minLength={PIN_MIN_LENGTH}
          />
        </div>
        <p role="status" className="mt-4 min-h-10 text-center text-sm leading-5 text-trail">
          {message}
        </p>
        <button
          type="button"
          onClick={() => {
            setPerson(null);
            setPin("");
            setMessage(null);
          }}
          className={`${secondaryButtonClass} mt-2`}
        >
          ‹ Not me
        </button>
      </HudCard>
    );
  }

  return (
    <HudCard eyebrow={deviceName} title="Who's working?" titleId="bay-heading" className="max-w-2xl">
      {signOutFailed && (
        <p role="alert" className="mt-4 text-sm text-trail">
          Couldn&apos;t sign out the last person. Check the Wi-Fi, then reload this page.
        </p>
      )}
      {people.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-ink-muted">
          No one has a PIN yet. Sign in with your password on a computer or your phone, then set a PIN
          on the Home tab.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {people.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => choose(p)}
                className="flex min-h-20 w-full flex-col items-start justify-center rounded-xl border border-white/10 bg-forest-950/70 px-4 py-3 text-left transition hover:border-glow/40 active:bg-glow/15 focus-visible:ring-2 focus-visible:ring-glow/50 focus-visible:outline-none"
              >
                <span className="text-lg font-medium text-ink">{p.name}</span>
                <span className="font-mono text-xs text-ink-muted">
                  {p.locked ? "PIN locked" : p.username}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-sm leading-6 text-ink-muted">
        No PIN yet, or locked out? Sign in at forcediagnostics.ai on a computer or your phone and set
        your PIN on the Home tab. A manager can also unlock a locked PIN.
      </p>
    </HudCard>
  );
}
