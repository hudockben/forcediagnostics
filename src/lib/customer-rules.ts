// The shop's customers and their vehicles (System Admin > Customers): what a
// record holds and how what's typed is checked. No server imports, so the
// forms use the same labels and limits the server checks against.

import { cutText } from "@/lib/manual-rules";
import { checkVin } from "@/lib/vin";

// How a vehicle is the customer's: bought from the dealership, sold or
// traded in to it, or theirs from somewhere else and brought in for service.
export const VEHICLE_RELATIONS = ["bought", "sold", "owned"] as const;
export type VehicleRelation = (typeof VEHICLE_RELATIONS)[number];

export const RELATION_LABELS: Record<VehicleRelation, string> = {
  bought: "Bought from us",
  sold: "Sold to us",
  owned: "Theirs, for service",
};

export const RELATION_HINTS: Record<VehicleRelation, string> = {
  bought: "They bought it from the dealership.",
  sold: "They sold or traded it in to the dealership.",
  owned: "Bought somewhere else; they bring it in for service.",
};

// The date that goes with each, if any.
export const RELATION_DATE_LABELS: Record<VehicleRelation, string | null> = {
  bought: "Date bought",
  sold: "Date sold",
  owned: null,
};

export const CUSTOMER_LIMITS = {
  name: 120,
  phone: 40,
  email: 254,
  addressLine: 120,
  city: 80,
  state: 40,
  postalCode: 12,
  notes: 2000,
} as const;

export const VEHICLE_LIMITS = {
  make: 40,
  model: 80,
  modelNumber: 30,
  color: 40,
  notes: 2000,
} as const;

export const MIN_VEHICLE_YEAR = 1950;
export const MAX_VEHICLE_YEAR = 2100;

export type CustomerFields = {
  name: string;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  notes: string | null;
};

export type VehicleFields = {
  relation: VehicleRelation;
  // YYYY-MM-DD; only for bought and sold.
  relationDate: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  modelNumber: string | null;
  vin: string | null;
  color: string | null;
  notes: string | null;
};

type Checked<K extends string, T> = { [key in K]: T } | { error: string };

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\u0000/g, "") : "");
// One line: runs of spaces, tabs and line breaks become one space.
const line = (value: unknown) => text(value).replace(/\s+/g, " ").trim();
// Notes keep their line breaks.
const block = (value: unknown) => text(value).replace(/\r\n?/g, "\n").trim();

const PHONE_ERROR = "A phone number is digits, with spaces, dashes or brackets if you like.";

// "555.123.4567", "+1 (555) 123-4567" -> "(555) 123-4567". Any other number
// of 7 to 15 digits (one from abroad, say) stays as typed. An extension
// ("x12", "ext. 12") goes on the end as "x12".
export function normalizePhone(value: unknown): Checked<"phone", string> {
  const typed = line(value);
  if (!typed) return { phone: "" };
  const [, number, extension] = /^(.*?)(?:\s*(?:x|ext\.?|#)\s*(\d{1,6}))?$/i.exec(typed)!;
  if (!/^\+?[\d ().-]+$/.test(number)) return { error: PHONE_ERROR };
  const digits = number.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return { error: "A phone number has 7 to 15 digits." };
  }
  // Ten digits, or eleven starting with 1, are a North American number,
  // unless a + says it's another country's.
  const local = digits.length === 10 ? digits : digits.length === 11 && digits[0] === "1" ? digits.slice(1) : null;
  const northAmerican = local !== null && (!number.startsWith("+") || digits.length === 11);
  const main = northAmerican ? `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}` : number;
  const phone = extension ? `${main} x${extension}` : main;
  if (phone.length > CUSTOMER_LIMITS.phone) return { error: "That phone number is too long." };
  return { phone };
}

export function normalizeEmail(value: unknown): Checked<"email", string> {
  const email = line(value);
  if (!email) return { email: "" };
  if (email.length > CUSTOMER_LIMITS.email || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    return { error: "That email address doesn't look right: it needs an @ and a domain, like name@example.com." };
  }
  return { email };
}

// A field longer than its box allows only gets here from outside the form.
function fits(value: string, max: number, what: string): string | null {
  return value.length > max ? `${what} is too long.` : null;
}

const orNull = (value: string) => value || null;

// What the customer form sends, checked and tidied: a state or province
// written as two letters and postcodes are upper-cased ("pa" -> "PA",
// "k1a 0b1" -> "K1A 0B1").
export function checkCustomer(input: Record<keyof CustomerFields, unknown>): Checked<"customer", CustomerFields> {
  const name = line(input.name);
  if (!name) return { error: "Enter the customer's name." };
  const phone = normalizePhone(input.phone);
  if ("error" in phone) return phone;
  const email = normalizeEmail(input.email);
  if ("error" in email) return email;
  const addressLine1 = line(input.addressLine1);
  const addressLine2 = line(input.addressLine2);
  const city = line(input.city);
  const typedState = line(input.state);
  const state = /^[a-z]{2}$/i.test(typedState) ? typedState.toUpperCase() : typedState;
  const postalCode = line(input.postalCode).toUpperCase();
  const notes = block(input.notes);
  const problem =
    fits(name, CUSTOMER_LIMITS.name, "That name") ??
    fits(addressLine1, CUSTOMER_LIMITS.addressLine, "The street address") ??
    fits(addressLine2, CUSTOMER_LIMITS.addressLine, "The second address line") ??
    fits(city, CUSTOMER_LIMITS.city, "The city") ??
    fits(state, CUSTOMER_LIMITS.state, "The state") ??
    fits(postalCode, CUSTOMER_LIMITS.postalCode, "The ZIP or postal code") ??
    fits(notes, CUSTOMER_LIMITS.notes, "The notes");
  if (problem) return { error: problem };
  return {
    customer: {
      name,
      phone: orNull(phone.phone),
      email: orNull(email.email),
      addressLine1: orNull(addressLine1),
      addressLine2: orNull(addressLine2),
      city: orNull(city),
      state: orNull(state),
      postalCode: orNull(postalCode),
      notes: orNull(notes),
    },
  };
}

export function isVehicleRelation(value: unknown): value is VehicleRelation {
  return typeof value === "string" && (VEHICLE_RELATIONS as readonly string[]).includes(value);
}

// A real calendar day between the model years the shop can hold.
function checkDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return year >= MIN_VEHICLE_YEAR && year <= MAX_VEHICLE_YEAR ? value : null;
}

// What the vehicle form sends, checked and tidied. The model number is
// upper-cased without spaces, as Polaris prints it (Z19VDE99AM); a VIN has
// to be a whole one (17 characters) and is kept even when its check digit
// doesn't match, as Diagnose keeps it. The date only goes with bought and
// sold.
export function checkVehicle(input: Record<keyof VehicleFields, unknown>): Checked<"vehicle", VehicleFields> {
  if (!isVehicleRelation(input.relation)) return { error: "Say how the vehicle is theirs: bought, sold to us, or theirs for service." };
  const relation = input.relation;
  const typedDate = line(input.relationDate);
  const relationDate = RELATION_DATE_LABELS[relation] && typedDate ? checkDate(typedDate) : null;
  if (RELATION_DATE_LABELS[relation] && typedDate && !relationDate) return { error: "That date isn't a real day." };

  const typedYear = line(input.year);
  let year: number | null = null;
  if (typedYear) {
    year = /^\d{4}$/.test(typedYear) ? Number(typedYear) : NaN;
    if (!(year >= MIN_VEHICLE_YEAR && year <= MAX_VEHICLE_YEAR)) {
      return { error: `The model year is four digits, ${MIN_VEHICLE_YEAR} to ${MAX_VEHICLE_YEAR}.` };
    }
  }
  const make = line(input.make);
  const model = line(input.model);
  const color = line(input.color);
  const notes = block(input.notes);
  const modelNumber = line(input.modelNumber).toUpperCase().replace(/\s+/g, "");
  if (modelNumber && !/^[A-Z0-9-]+$/.test(modelNumber)) {
    return { error: "A model number is only letters and digits (Z19VDE99AM)." };
  }
  const vin = checkVin(line(input.vin));
  if (vin.status === "invalid") return { error: vin.message };
  if (vin.status === "partial") {
    return { error: `${vin.message.split(":")[0]}: a VIN has 17. Put a serial number in the notes instead.` };
  }
  if (!model && !modelNumber && vin.status !== "ok") {
    return { error: "Enter at least the model, the model number or the VIN." };
  }
  const problem =
    fits(make, VEHICLE_LIMITS.make, "The make") ??
    fits(model, VEHICLE_LIMITS.model, "The model") ??
    fits(modelNumber, VEHICLE_LIMITS.modelNumber, "The model number") ??
    fits(color, VEHICLE_LIMITS.color, "The color") ??
    fits(notes, VEHICLE_LIMITS.notes, "The notes");
  if (problem) return { error: problem };
  return {
    vehicle: {
      relation,
      relationDate,
      year,
      make: orNull(make),
      model: orNull(model),
      modelNumber: orNull(modelNumber),
      vin: vin.status === "ok" ? vin.vin : null,
      color: orNull(color),
      notes: orNull(notes),
    },
  };
}

type VehicleName = Pick<VehicleFields, "year" | "make" | "model" | "modelNumber" | "vin">;

// "2021 Polaris Sportsman 850", or by its model number or VIN when that's
// all there is.
export function vehicleLabel(vehicle: VehicleName) {
  if (vehicle.make || vehicle.model) return [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
  if (vehicle.modelNumber) return [vehicle.year, vehicle.modelNumber].filter(Boolean).join(" ");
  if (vehicle.vin) return `VIN ${vehicle.vin}`;
  return vehicle.year ? `${vehicle.year} vehicle` : "Vehicle";
}

// The address as it's written on an envelope, one line each; none when
// there's no address.
export function addressLines(customer: Pick<CustomerFields, "addressLine1" | "addressLine2" | "city" | "state" | "postalCode">) {
  const place = [customer.city, [customer.state, customer.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [customer.addressLine1, customer.addressLine2, place].filter((part): part is string => Boolean(part));
}

// "6/24/2024" from "2024-06-24", the way the shop writes dates on paper.
export function formatDay(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return `${month}/${date}/${year}`;
}

// A customer's vehicle as Diagnose shows and picks it: whose it is and
// what it is, never how to reach them.
export type CustomerVehicleChoice = {
  vehicleId: string;
  customerId: string;
  customerName: string;
  label: string;
  relation: VehicleRelation;
  year: number | null;
  model: string | null;
  modelNumber: string | null;
  vin: string | null;
};

// The customer a diagnosis is for (ConversationView.customer).
export type ConversationCustomer = Pick<CustomerVehicleChoice, "vehicleId" | "customerId" | "customerName" | "label">;

export const conversationCustomer = (choice: CustomerVehicleChoice): ConversationCustomer => ({
  vehicleId: choice.vehicleId,
  customerId: choice.customerId,
  customerName: choice.customerName,
  label: choice.label,
});

// What a new diagnosis's quick form starts with for a customer's vehicle:
// its model number and VIN, or, with no model number, its year and model
// typed as the Model ("2021 Sportsman 850", which Diagnose reads as the
// year and the model's name).
export function diagnoseStartFields(vehicle: Pick<CustomerVehicleChoice, "year" | "model" | "modelNumber" | "vin">) {
  return {
    modelNumber: vehicle.modelNumber ?? "",
    vin: vehicle.vin ?? "",
    model: vehicle.modelNumber ? "" : cutText([vehicle.year, vehicle.model].filter(Boolean).join(" "), 60),
  };
}
