"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { HudCard, primaryButtonClass, secondaryButtonClass } from "@/components/hud";
import { PinPad } from "@/components/pin-pad";
import { endBaySession, endedSession, readPair, readStore, SESSION_KEY } from "@/lib/bay-client";
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
  // Coming to this screen means switching user, so whoever was signed in on
  // the tablet when it loaded is signed out. A session that turns up later
  // (the list refreshes) was started in another tab, and is followed instead.
  const [leftover] = useState(leftoverSessionId);

  // End only that session, so this can't end a sign-in made meanwhile, and
  // send other tabs still showing that person to the name list.
  useEffect(() => {
    if (!leftover) return;
    stopLeftover.current = false;
    (async () => {
      for (let attempt = 0; attempt < 5 && !stopLeftover.current; attempt++) {
        if (await endBaySession(leftover)) {
          if (readPair(readStore(SESSION_KEY))?.[0] === leftover) endedSession();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (!stopLeftover.current) setSignOutFailed(true);
    })();
    return () => {
      stopLeftover.current = true;
    };
  }, [leftover]);

  // Someone signed in from another tab: this tab follows them, unless it's
  // in use itself. A refresh that finds their session catches a missed
  // storage event.
  const idleOnList = !person && !signedIn && !pending;
  useEffect(() => {
    if (!idleOnList) return;
    const follow = (sessionId: string | undefined) => {
      if (!sessionId || sessionId === "none" || sessionId === leftover) return;
      stopLeftover.current = true;
      goHome();
    };
    if (leftoverSessionId !== leftover) follow(leftoverSessionId ?? undefined);
    const onStorage = (event: StorageEvent) => {
      if (event.key === SESSION_KEY) follow(readPair(event.newValue)?.[0]);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [idleOnList, leftover, leftoverSessionId]);

  // A sign-in in another tab while this page was loading: ask the server
  // whether it's still current (the refresh then follows it).
  useEffect(() => {
    const started = readPair(readStore(SESSION_KEY))?.[0];
    if (started && started !== "none" && started !== leftover) router.refresh();
  }, [leftover, router]);

  // Back to the name list, signing out whoever just signed in here. If
  // someone else has signed in from another tab meanwhile, follow them
  // instead of signing them out.
  const leave = useCallback(async (sessionId: string) => {
    setLeaving(true);
    await endBaySession(sessionId);
    const current = readPair(readStore(SESSION_KEY))?.[0];
    if (current && current !== sessionId && current !== "none") {
      goHome();
      return;
    }
    if (current === sessionId) endedSession();
    window.location.replace("/bay");
  }, []);

  useEffect(() => {
    if (!person && !signedIn) return;
    const timer = window.setInterval(() => {
      if (signedIn) {
        // Signed in or out from another tab since: this screen is stale.
        const current = readPair(readStore(SESSION_KEY))?.[0];
        if (current && current !== signedIn.sessionId) {
          window.clearInterval(timer);
          if (current === "none") window.location.replace("/bay");
          else goHome();
          return;
        }
      }
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
