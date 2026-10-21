"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { HudCard, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { PinPad } from "@/components/pin-pad";
import { endBaySession, endedSession } from "@/lib/bay-client";
import { PIN_MIN_LENGTH } from "@/lib/pin-rules";
import { describeWarning, signInWithPin } from "@/lib/pin-sign-in";

type Person = { id: string; name: string; username: string; locked: boolean };

// A half-typed PIN is cleared, and the name list comes back, after this long.
// The same goes for the heads-up screen after a sign-in, which also signs
// that person out again.
const PIN_IDLE_MS = 60 * 1000;
// The name list is fetched again this often while it's showing, so new PINs
// and locks show up.
const LIST_REFRESH_MS = 60 * 1000;

const goHome = () => window.location.replace("/home");

export function BayPicker({
  deviceName,
  people,
  leftoverSessionId,
}: {
  deviceName: string;
  people: Person[];
  leftoverSessionId: string | null;
}) {
  const router = useRouter();
  const [person, setPerson] = useState<Person | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Signed in, showing a warning about wrong tries before going on.
  const [signedIn, setSignedIn] = useState<{ sessionId: string; warning: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const lastTouch = useRef(0);
  const touch = useCallback(() => {
    lastTouch.current = Date.now();
  }, []);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const stopLeftover = useRef(false);

  // If someone is still signed in on this tablet (an idle lock that couldn't
  // reach the server, say), end that session. Only that one, so it can't end
  // a sign-in made here meanwhile.
  useEffect(() => {
    if (!leftoverSessionId) return;
    stopLeftover.current = false;
    (async () => {
      for (let attempt = 0; attempt < 5 && !stopLeftover.current; attempt++) {
        if (await endBaySession(leftoverSessionId)) return;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (!stopLeftover.current) setSignOutFailed(true);
    })();
    return () => {
      stopLeftover.current = true;
    };
  }, [leftoverSessionId]);

  // Back to the name list, signing out whoever just signed in here.
  const leave = useCallback(async (sessionId: string) => {
    setLeaving(true);
    await endBaySession(sessionId);
    endedSession();
    window.location.replace("/bay");
  }, []);

  useEffect(() => {
    if (!person && !signedIn) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastTouch.current <= PIN_IDLE_MS) return;
      if (signedIn) {
        window.clearInterval(timer);
        void leave(signedIn.sessionId);
        return;
      }
      setPerson(null);
      setPin("");
      setMessage(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [person, signedIn, leave]);

  // Keep the names fresh while nobody is using the screen.
  useEffect(() => {
    if (person || signedIn) return;
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, LIST_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [person, signedIn, router]);

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
    stopLeftover.current = true;
    const result = await signInWithPin(person.id, pin);
    setPin("");
    if (result.ok) {
      if (result.warning) {
        touch();
        setSignedIn({ sessionId: result.sessionId, warning: describeWarning(result.warning) });
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

  if (signedIn && person) {
    return (
      <HudCard eyebrow={deviceName} title={`Heads up, ${person.name}`} titleId="bay-heading">
        <div onPointerDown={touch}>
          <p role="alert" className="mt-4 text-base leading-7 text-trail">
            {signedIn.warning}
          </p>
          <button type="button" onClick={goHome} disabled={leaving} className={`${primaryButtonClass} mt-6`}>
            Continue
          </button>
          <button
            type="button"
            onClick={() => leave(signedIn.sessionId)}
            disabled={leaving}
            className={`${secondaryButtonClass} mt-3`}
          >
            {leaving ? "Signing out…" : `Not ${person.name}? Sign out`}
          </button>
        </div>
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
