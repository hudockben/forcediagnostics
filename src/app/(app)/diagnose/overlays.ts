import { useSyncExternalStore } from "react";

// What every full-screen view of Diagnose shares (the examine view, a
// system's sheet on its own, a manual page): where it goes in the
// document, and holding the page behind it.

// True in the browser once hydrated, false on the server: portals into
// the document only where there is one.
const noSubscribe = () => () => {};
export function useMounted() {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

// Where full-screen views go: inside the app's shell (so the bay tablet's
// lock, which makes the whole shell inert, covers them too), beside the
// page they cover.
export function overlayRoot() {
  return document.getElementById("app-overlays") ?? document.body;
}

// While a full-screen view is open: the page behind it doesn't scroll and
// is inert (out of the tab order and hidden from screen readers): every
// part of the app's shell but the overlays the views live in. The bay
// tablet's lock makes the whole shell inert on top of that, views and all,
// and lifting it leaves the page held. Returns the undo. Counted, so the
// page is let go when the last view goes, in whatever order they go (Back
// closes the top one; leaving the page, say by Open in manual, takes them
// all).
let holds = 0;
let held: { overflow: string; inert: [Element, boolean][] } | null = null;
export function holdPage(focus: HTMLElement | null) {
  const root = document.documentElement;
  if (holds++ === 0) {
    const shell = document.getElementById("app-shell");
    const page = shell ? [...shell.children].filter((child) => child.id !== "app-overlays") : [];
    held = { overflow: root.style.overflow, inert: page.map((element): [Element, boolean] => [element, (element as HTMLElement).inert]) };
    root.style.overflow = "hidden";
    for (const element of page) (element as HTMLElement).inert = true;
  }
  focus?.focus({ preventScroll: true });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds > 0 || !held) return;
    root.style.overflow = held.overflow;
    for (const [element, inert] of held.inert) (element as HTMLElement).inert = inert;
    held = null;
  };
}
