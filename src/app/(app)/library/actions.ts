"use server";

import { getReadyManual } from "@/lib/library";
import { pdfFileName } from "@/lib/manual-rules";
import { requireCapability } from "@/lib/session";
import { isStorageConfigured, r2Storage } from "@/lib/storage";

// A fresh link to a manual's PDF, for the viewer when the one it was given
// has run out (they last 15 minutes), and for Diagnose's page pictures. Only
// the user's own shop's ready manuals; the file's size and page count come
// with it (pdf.js reads the file a part at a time, so it needs the size).
export async function getManualFileUrl(
  manualId: string,
): Promise<{ url: string; sizeBytes: number; pageCount: number } | { error: string }> {
  const user = await requireCapability("library.read");
  if (!isStorageConfigured) return { error: "File storage isn't set up." };
  const manual = await getReadyManual(user.shop.id, String(manualId ?? ""));
  if (!manual) return { error: "That manual isn't in the library any more." };
  return {
    url: await r2Storage.downloadUrl(manual.storageKey, pdfFileName(manual.title)),
    sizeBytes: manual.sizeBytes,
    pageCount: manual.pageCount,
  };
}
