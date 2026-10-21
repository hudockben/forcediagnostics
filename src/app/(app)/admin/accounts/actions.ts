"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { requireCapability } from "@/lib/session";
import {
  createStaffMember,
  resetStaffPassword,
  setStaffDisabled,
  updateStaffMember,
} from "@/lib/staff";

export type FormState = { error?: string; success?: string };

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

// Every action re-checks the permission: server actions can be called
// directly, not just from these pages.

export async function addStaff(_previous: FormState, form: FormData): Promise<FormState> {
  const admin = await requireCapability("accounts.manage");
  const result = await createStaffMember(admin, {
    name: field(form, "name"),
    username: field(form, "username"),
    role: field(form, "role"),
    password: field(form, "password"),
  });
  if ("error" in result) return { error: result.error };
  redirect(`/admin/accounts?added=${encodeURIComponent(result.id ?? "")}`);
}

export async function saveDetails(_previous: FormState, form: FormData): Promise<FormState> {
  const admin = await requireCapability("accounts.manage");
  const result = await updateStaffMember(admin, field(form, "id"), {
    name: field(form, "name"),
    role: field(form, "role"),
  });
  if ("error" in result) return { error: result.error };
  refresh();
  return { success: "Saved." };
}

export async function resetPassword(_previous: FormState, form: FormData): Promise<FormState> {
  const admin = await requireCapability("accounts.manage");
  const result = await resetStaffPassword(admin, field(form, "id"), field(form, "password"));
  if ("error" in result) return { error: result.error };
  return { success: "Password reset. They've been signed out everywhere." };
}

export async function setDisabled(_previous: FormState, form: FormData): Promise<FormState> {
  const admin = await requireCapability("accounts.manage");
  const disable = field(form, "disable") === "true";
  const result = await setStaffDisabled(admin, field(form, "id"), disable);
  if ("error" in result) return { error: result.error };
  refresh();
  return { success: disable ? "Account disabled and signed out." : "Account turned back on." };
}
