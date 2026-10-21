"use client";

import { useEffect } from "react";

import { signedInWasShown } from "@/lib/signed-in-flag";

// On the sign-in and PIN screens: if someone's signed-in screens were shown
// earlier in this page load, start a fresh page load (see signed-in-flag.ts).
export function ReloadIfSignedInShown() {
  useEffect(() => {
    if (signedInWasShown()) window.location.reload();
  }, []);
  return null;
}
