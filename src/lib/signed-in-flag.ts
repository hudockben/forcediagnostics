"use client";

// Set once signed-in screens have been shown in this page load. If the
// server later sends the browser to the sign-in or PIN screen with a client
// navigation, those screens reload the page, so nothing of the previous
// person's (cached pages, typed text) stays in memory.
let shown = false;

export function markSignedInShown() {
  shown = true;
}

export function signedInWasShown() {
  return shown;
}
