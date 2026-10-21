"use client";

import { useEffect } from "react";

import { markSignedInShown } from "@/lib/signed-in-flag";

export function SignedInMarker() {
  useEffect(() => markSignedInShown(), []);
  return null;
}
