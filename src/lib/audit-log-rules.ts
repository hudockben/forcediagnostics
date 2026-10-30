// System Admin > Activity log: its areas, what each kind of entry says in
// words, how the check of its seals reads, and the log as CSV. No server
// imports, so it's tested on its own (src/lib/audit-log.ts reads the log).

import { RELATION_LABELS, type VehicleRelation } from "@/lib/customer-rules";
import { ROLE_LABELS } from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/roles";
import { SUPPLIER_FIELD_LABELS, type SupplierField } from "@/lib/supplier-rules";

export const AUDIT_LOG_PAGE_SIZE = 25;

// The filter's areas, by the kinds of record each covers (target_type).
export const AUDIT_AREAS = {
  diagnoses: { label: "Diagnoses", targetTypes: ["diagnosis"] },
  customers: { label: "Customers", targetTypes: ["customer", "customer_vehicle"] },
  stickers: { label: "Sticker & Plate log", targetTypes: ["sticker"] },
  suppliers: { label: "Supplier", targetTypes: ["supplier"] },
  accounts: { label: "Accounts and PINs", targetTypes: ["user"] },
  tablets: { label: "Bay tablets", targetTypes: ["device"] },
  manuals: { label: "Manuals", targetTypes: ["manual", "manual_catalog"] },
} as const satisfies Record<string, { label: string; targetTypes: readonly string[] }>;

export type AuditArea = keyof typeof AUDIT_AREAS;
export const AUDIT_AREA_KEYS = Object.keys(AUDIT_AREAS) as AuditArea[];

// ?area= from the address: one of the areas, or all of them.
export const parseAreaFilter = (value: unknown): AuditArea | null =>
  typeof value === "string" && Object.hasOwn(AUDIT_AREAS, value) ? (value as AuditArea) : null;

export function areaOf(targetType: string): AuditArea | null {
  return AUDIT_AREA_KEYS.find((area) => (AUDIT_AREAS[area].targetTypes as readonly string[]).includes(targetType)) ?? null;
}

export type AuditLogEntry = {
  id: string;
  // Its place in the shop's log, from 1; null only if it was never sealed.
  seq: number | null;
  createdAt: Date;
  // Who did it, by their name then; both null for what the app did itself
  // (a PIN locked after wrong tries, a tablet paired).
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  hash: string | null;
  prevHash: string | null;
};

// A line under an entry's summary: "Reason: test entry". A time is an ISO
// string, shown in the viewer's time zone.
export type AuditFact = { label: string; value: string; time?: true };
export type AuditDescription = { summary: string; facts: AuditFact[] };

const str = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

// ["phone", "email", "notes"] -> "phone, email and notes"
function inWords(items: string[]) {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const CUSTOMER_FIELD_WORDS: Record<string, string> = {
  name: "name",
  phone: "phone number",
  email: "email",
  addressLine1: "address",
  addressLine2: "second address line",
  city: "town",
  state: "state",
  postalCode: "ZIP code",
  notes: "notes",
};

const VEHICLE_FIELD_WORDS: Record<string, string> = {
  relation: "deal",
  relationDate: "date",
  year: "year",
  make: "make",
  model: "model",
  modelNumber: "model number",
  vin: "VIN",
  color: "color",
  notes: "notes",
};

const STICKER_FIELD_WORDS: Record<string, string> = {
  stickerNumber: "number",
  plateClass: "classification",
  customerId: "customer",
};

// The fields an edit changed, in words: the log names them, never what
// they were or are.
function fieldsInWords(value: unknown, words: Record<string, string>) {
  const fields = Array.isArray(value) ? value.filter((field): field is string => typeof field === "string") : [];
  return inWords(fields.map((field) => words[field] ?? field));
}

const roleLabel = (value: unknown) =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value) ? ROLE_LABELS[value as Role] : str(value);

const relationLabel = (value: unknown) =>
  typeof value === "string" && Object.hasOwn(RELATION_LABELS, value) ? RELATION_LABELS[value as VehicleRelation] : str(value);

// What an entry says in words, without who (shown beside it). Kinds of
// entry this doesn't know yet say what they are and what they were on.
export function describeAuditEntry(entry: Pick<AuditLogEntry, "action" | "targetType" | "targetId" | "details">): AuditDescription {
  const d = entry.details ?? {};
  const facts: AuditFact[] = [];
  const fact = (label: string, value: unknown, time?: true) => {
    const text = str(value);
    if (!text) return;
    facts.push(time && !Number.isNaN(Date.parse(text)) ? { label, value: text, time } : { label, value: text });
  };
  const who = str(d.username) || "an account";
  const summary = (() => {
    switch (entry.action) {
      // Accounts and PINs
      case "account.created":
        return `Added ${who} as ${roleLabel(d.role)}`;
      case "account.updated": {
        const role = d.role as { from?: unknown; to?: unknown } | undefined;
        const name = d.name as { from?: unknown; to?: unknown } | undefined;
        const parts = [
          role && `changed ${who} from ${roleLabel(role.from)} to ${roleLabel(role.to)}`,
          name && `renamed ${who} from ${str(name.from)} to ${str(name.to)}`,
        ].filter(Boolean);
        const text = parts.join(" and ") || `updated ${who}`;
        return text[0].toUpperCase() + text.slice(1);
      }
      case "account.disabled":
        return `Disabled ${who}`;
      case "account.enabled":
        return `Turned ${who} back on`;
      case "account.password_reset":
        return `Reset the password for ${who}`;
      case "pin.set":
        return d.by === "self" ? "Set their own bay tablet PIN" : `Set the bay tablet PIN for ${who}`;
      case "pin.removed":
        return d.by === "self" ? "Removed their own bay tablet PIN" : `Removed the bay tablet PIN for ${who}`;
      case "pin.unlocked":
        return `Unlocked the bay tablet PIN for ${who}`;
      case "pin.locked":
        return d.kind === "hard"
          ? `${who}'s PIN locked until unlocked (too many wrong PINs today)`
          : `${who}'s PIN locked for 15 minutes (wrong PINs)`;

      // Bay tablets
      case "device.pairing_code":
        return `Made a pairing code for ${str(d.name) || "a tablet"}`;
      case "device.paired":
        return `${str(d.name) || "A tablet"} was paired`;
      case "device.removed":
        return `Removed ${str(d.name) || "a tablet"}`;

      // Customers
      case "customer.created":
        return `Added the customer ${str(d.name)}${d.from === "sticker log" ? " from the Sticker & Plate log" : ""}`;
      case "customer.updated": {
        const fields = fieldsInWords(d.fields, CUSTOMER_FIELD_WORDS);
        return fields ? `Changed ${str(d.name)}'s ${fields}` : `Updated ${str(d.name)}`;
      }
      case "customer.removed": {
        const vehicles = num(d.vehicles);
        return `Removed the customer ${str(d.name)}${vehicles > 0 ? ` and ${plural(vehicles, "vehicle", "vehicles")}` : ""}`;
      }
      case "vehicle.added":
        fact("Deal", relationLabel(d.relation));
        return `Added the ${str(d.vehicle) || "vehicle"} to a customer's record`;
      case "vehicle.updated": {
        const fields = fieldsInWords(d.fields, VEHICLE_FIELD_WORDS);
        return fields ? `Changed the ${str(d.vehicle) || "vehicle"}'s ${fields}` : `Updated the ${str(d.vehicle) || "vehicle"}`;
      }
      case "vehicle.removed":
        return `Removed the ${str(d.vehicle) || "vehicle"} from a customer's record`;
      case "customers.imported":
        fact("Customers added", num(d.created));
        fact("Already on file", `${num(d.matched)}${num(d.filled) > 0 ? ` (${num(d.filled)} filled in)` : ""}`);
        fact("Vehicles added", num(d.vehiclesAdded));
        if (num(d.failed) > 0) fact("Left out", num(d.failed));
        return `Imported customers from ${str(d.fileName) || "a file"}`;

      // Sticker & Plate log
      case "sticker.logged":
        return `Logged sticker ${str(d.stickerNumber)}, Class ${str(d.plateClass)}`;
      case "sticker.updated": {
        const fields = fieldsInWords(d.fields, STICKER_FIELD_WORDS);
        const was = str(d.was);
        return `Corrected sticker ${str(d.stickerNumber)}${fields ? `: its ${fields}` : ""}${was ? ` (it was ${was})` : ""}`;
      }
      case "sticker.removed":
        return `Removed sticker ${str(d.stickerNumber)}, Class ${str(d.plateClass)}, from the log`;

      // Supplier
      case "supplier.created":
        return `Added the supplier ${str(d.supplierName)} (${str(d.supplierId)})`;
      case "supplier.updated": {
        const fields = fieldsInWords(d.fields, SUPPLIER_FIELD_LABELS as Record<SupplierField, string>);
        return `Changed supplier ${str(d.supplierId)}${fields ? `: ${fields}` : ""}`;
      }
      case "supplier.removed":
        return `Removed the supplier ${str(d.supplierName)} (${str(d.supplierId)})`;
      case "suppliers.imported":
        fact("Added", num(d.created));
        fact("Updated", num(d.updated));
        fact("Unchanged", num(d.unchanged));
        if (num(d.failed) > 0) fact("Left out", num(d.failed));
        return `Imported suppliers from ${str(d.fileName) || "a file"}`;

      // Manuals
      case "manual.added":
        fact("File", d.fileName);
        fact("Pages", num(d.pages) > 0 ? `${num(d.pages)}${num(d.pagesWithoutText) > 0 ? ` (${num(d.pagesWithoutText)} scanned)` : ""}` : "");
        return `Added the manual ${str(d.title) || str(d.fileName)}`;
      case "manual.ocr": {
        const pages = Array.isArray(d.pages) ? d.pages.length : 0;
        fact("Found words on", plural(num(d.pagesGainedText), "page", "pages"));
        if (d.finished === true) fact("Finished", "every scanned page read");
        return `Read ${plural(pages, "scanned page", "scanned pages")} of ${str(d.title) || str(d.fileName)}`;
      }
      case "manual.name_linked":
        return `Linked the file name ${str(d.fileName)} to ${str(d.manualFileName)}, the same file`;
      case "manual_catalog.imported":
        fact("Manuals", num(d.manuals));
        fact("Models", num(d.models));
        return `Imported the model list ${str(d.fileName)}`;

      // Diagnoses
      case "diagnosis.deleted": {
        fact("Unit", [str(d.unit), str(d.vin) && `VIN ${str(d.vin)}`].filter(Boolean).join(" · "));
        fact("Started by", d.startedByName);
        fact("Started", d.startedAt, true);
        fact("Messages", num(d.messages));
        fact("Status", d.status === "solved" ? `Solved: ${str(d.fix)}` : "Open");
        fact("Customer", d.customerName);
        fact("Reason", d.reason);
        return `Deleted the diagnosis “${str(d.title)}”`;
      }
      default:
        return `${entry.action} on ${entry.targetType} ${entry.targetId}`;
    }
  })();
  return { summary, facts };
}

// Who an entry was by, as shown.
export const authorOf = (entry: Pick<AuditLogEntry, "actorUserId" | "actorName">) =>
  entry.actorName ?? (entry.actorUserId ? "An account since removed" : "The app");

// The check of a shop's seals (verifyAuditLog in src/lib/audit-log.ts).
export type AuditLogCheck = {
  entries: number;
  // The entry the chain first stops holding at, and why, if it does.
  broken: { seq: number; reason: "changed" | "missing" | "relinked" } | null;
  // Entries without a seal: added while the seal's trigger was off.
  unsealed: number;
  // The last entry, whose hash stands for the whole log up to it.
  last: { seq: number; hash: string; createdAt: Date } | null;
};

// What the check says, in words.
export function checkInWords(check: AuditLogCheck): { ok: boolean; text: string } {
  if (check.broken) {
    const at = `entry #${check.broken.seq.toLocaleString("en-US")}`;
    const why = {
      changed: `${at} was changed after it was written: it no longer matches its seal`,
      missing: `an entry is missing before ${at}: one was taken out`,
      relinked: `the entry before ${at} isn't the one it was sealed after: one was changed or taken out`,
    }[check.broken.reason];
    return { ok: false, text: `The log doesn't check out: ${why}.` };
  }
  if (check.unsealed > 0) {
    return {
      ok: false,
      text: `The log doesn't check out: ${plural(check.unsealed, "entry was", "entries were")} added without a seal, behind the app's back.`,
    };
  }
  if (check.entries === 0) return { ok: true, text: "Nothing in the log yet." };
  return {
    ok: true,
    text: `The log checks out: ${check.entries === 1 ? "its one entry is" : `all ${check.entries.toLocaleString("en-US")} entries are`} as written, with none taken out.`,
  };
}

// A hash, shortened to show: "3f9a1c2d…c1d2".
export const shortHash = (hash: string) => (hash.length > 16 ? `${hash.slice(0, 12)}…${hash.slice(-4)}` : hash);

// "2026-10-30 15:04:05" in the time zone, which a spreadsheet reads as a
// date and time.
function dateTime(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// The log as CSV, oldest first, for a spreadsheet or to keep: each entry in
// words, and as stored, with its hash and the one before it, so a copy kept
// elsewhere shows later whether the log still holds the same entries. A
// byte order mark for Excel, and a cell starting with = + - or @ kept as
// text.
export function auditLogCsv(entries: AuditLogEntry[], timeZone = "America/New_York"): string {
  const cell = (value: string) => {
    const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    "#,When,Who,What,Details,Area,Action,Record,Fingerprint,Previous fingerprint,Data",
    ...entries.map((entry) => {
      const { summary, facts } = describeAuditEntry(entry);
      const area = areaOf(entry.targetType);
      return [
        entry.seq === null ? "" : String(entry.seq),
        dateTime(entry.createdAt, timeZone),
        authorOf(entry),
        summary,
        facts.map((f) => `${f.label}: ${f.time ? dateTime(new Date(f.value), timeZone) : f.value}`).join("; "),
        area ? AUDIT_AREAS[area].label : "",
        entry.action,
        `${entry.targetType} ${entry.targetId}`,
        entry.hash ?? "",
        entry.prevHash ?? "",
        JSON.stringify(entry.details ?? {}),
      ]
        .map(cell)
        .join(",");
    }),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
