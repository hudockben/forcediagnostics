"use server";

import { DrizzleQueryError } from "drizzle-orm";
import { unstable_rethrow } from "next/navigation";

import {
  finishCatalogImport,
  saveCatalogBatch,
  type CatalogFinishResult,
  type CatalogSaveResult,
} from "@/lib/manual-catalog";
import type { PageText } from "@/lib/manual-rules";
import {
  confirmManualUpload,
  finishManual,
  saveManualPages,
  startManualUpload,
  type ConfirmResult,
  type FinishResult,
  type SaveResult,
  type StartResult,
} from "@/lib/manuals";
import { requireCapability } from "@/lib/session";
import { isStorageConfigured, r2Storage } from "@/lib/storage";

// The uploader on System Admin > Manuals calls these for each file, in
// order (see src/lib/manuals.ts), and for the model list (see
// src/lib/manual-catalog.ts). Every action re-checks the permission: server
// actions can be called directly, not just from the page.

async function attempt<T>(what: string, run: () => Promise<T | { error: string }>) {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`Couldn't ${what}`, error instanceof DrizzleQueryError ? error.cause : error);
    return { error: "Couldn't save that. Check the connection and retry." };
  }
}

const storageMissing = { error: "File storage isn't set up yet." };

export async function startUpload(input: {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}): Promise<StartResult> {
  return attempt("start a manual upload", async () => {
    const admin = await requireCapability("settings.manage");
    if (!isStorageConfigured) return storageMissing;
    return startManualUpload(
      admin,
      {
        fileName: String(input?.fileName ?? ""),
        sizeBytes: Number(input?.sizeBytes),
        sha256: String(input?.sha256 ?? ""),
      },
      r2Storage,
    );
  });
}

export async function confirmUpload(input: { manualId: string; pageCount: number }): Promise<ConfirmResult> {
  return attempt("confirm a manual upload", async () => {
    const admin = await requireCapability("settings.manage");
    if (!isStorageConfigured) return storageMissing;
    return confirmManualUpload(
      admin,
      { manualId: String(input?.manualId ?? ""), pageCount: Number(input?.pageCount) },
      r2Storage,
    );
  });
}

export async function savePages(input: { manualId: string; pages: PageText[] }): Promise<SaveResult> {
  return attempt("save manual pages", async () => {
    const admin = await requireCapability("settings.manage");
    return saveManualPages(admin, { manualId: String(input?.manualId ?? ""), pages: input?.pages });
  });
}

export async function finishUpload(input: { manualId: string }): Promise<FinishResult> {
  return attempt("finish a manual", async () => {
    const admin = await requireCapability("settings.manage");
    return finishManual(admin, { manualId: String(input?.manualId ?? "") });
  });
}

export async function saveModelList(input: { importId: string; files: unknown }): Promise<CatalogSaveResult> {
  return attempt("save the model list", async () => {
    const admin = await requireCapability("settings.manage");
    return saveCatalogBatch(admin, { importId: String(input?.importId ?? ""), files: input?.files });
  });
}

export async function finishModelList(input: {
  importId: string;
  fileName: string;
  leftOut: number;
  rowsWithoutFile: number;
}): Promise<CatalogFinishResult> {
  return attempt("finish the model list", async () => {
    const admin = await requireCapability("settings.manage");
    return finishCatalogImport(admin, {
      importId: String(input?.importId ?? ""),
      fileName: String(input?.fileName ?? ""),
      leftOut: Number(input?.leftOut),
      rowsWithoutFile: Number(input?.rowsWithoutFile),
    });
  });
}
