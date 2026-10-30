import "server-only";

import { DrizzleQueryError, and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

import { withShop, type ShopTransaction } from "@/db";
import { auditLog, customerVehicles, customers, diagnosisConversations, users } from "@/db/schema";
import {
  checkCustomer,
  checkVehicle,
  conversationCustomer,
  vehicleLabel,
  type ConversationCustomer,
  type CustomerFields,
  type CustomerVehicleChoice,
  type VehicleFields,
  type VehicleRelation,
} from "@/lib/customer-rules";
import { containsPattern, listPage, listSearchWords, type ListPage } from "@/lib/diagnose-list-rules";
import { isUuid, type ConversationStatus } from "@/lib/diagnose-rules";
import type { CurrentUser } from "@/lib/session";

// The shop's customers and their vehicles, for System Admin > Customers, and
// the little of them Diagnose sees (a customer's name and vehicles, to say
// whose unit a diagnosis is for). Callers check repair_orders.intake (or
// diagnostics.work, for the Diagnose parts) first; everything here runs
// inside withShop for the user's own shop.

export type Result = { ok: true } | { error: string };

const NOT_HERE = { error: "That customer isn't in this shop." };
const VEHICLE_NOT_HERE = { error: "That vehicle isn't on this customer's record." };

export const CUSTOMER_PAGE_SIZE = 20;

async function audit(
  tx: ShopTransaction,
  actor: CurrentUser,
  action: string,
  target: { type: "customer" | "customer_vehicle"; id: string },
  details: Record<string, unknown>,
) {
  await tx.insert(auditLog).values({
    shopId: actor.shop.id,
    actorUserId: actor.id,
    action,
    targetType: target.type,
    targetId: target.id,
    details,
  });
}

// Which fields an edit changed, by name only: the audit log says who
// changed a customer's phone number, not what it was or is.
function changedFields<T extends Record<string, unknown>>(before: T, after: T) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

const isForeignKeyViolation = (error: unknown) =>
  ((error instanceof DrizzleQueryError ? error.cause : error) as { code?: string } | undefined)?.code === "23503";

// --- The list ---------------------------------------------------------------

export type CustomerSummary = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  vehicles: Record<VehicleRelation, number>;
};

export type CustomerList = ListPage & { items: CustomerSummary[]; total: number };

// The customer's id from inside a subquery. Spelt out: in a query on one
// table Drizzle leaves the table's name off its columns, and a bare "id"
// in the subquery would be the vehicle's own.
const outerCustomerId = sql`${customers}.${sql.identifier("id")}`;

const vehicleCount = (relation: VehicleRelation) =>
  sql<number>`(select count(*) from ${customerVehicles} v where v.customer_id = ${outerCustomerId} and v.relation = ${relation})::int`;

// What a search of the list looks through: the customer's name, phone
// number (also as bare digits, so 5551234567 finds "(555) 123-4567"),
// email and address, and their vehicles' year, make, model, model number,
// VIN and color. Every word has to be somewhere, in any order and any case,
// as on the Diagnose list.
function customerSearch(query: string): SQL | undefined {
  const words = listSearchWords(query);
  if (words.length === 0) return undefined;
  const text = sql`concat_ws(' ',
    ${customers.name}, ${customers.phone}, regexp_replace(coalesce(${customers.phone}, ''), '[^0-9]', '', 'g'),
    ${customers.email}, ${customers.addressLine1}, ${customers.addressLine2}, ${customers.city}, ${customers.state},
    ${customers.postalCode},
    (select string_agg(concat_ws(' ', v.year, v.make, v.model, v.model_number, v.vin, v.color), ' ')
     from ${customerVehicles} v where v.customer_id = ${outerCustomerId}))`;
  const patterns = sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  );
  return sql`${text} ilike all (array[${patterns}]::text[])`;
}

// One page of the shop's customers, A to Z, or of those a search finds. A
// page past the end gives the last one.
export async function listCustomers(
  shopId: string,
  { query = "", page = 1, perPage = CUSTOMER_PAGE_SIZE }: { query?: string; page?: number; perPage?: number } = {},
): Promise<CustomerList> {
  const where = customerSearch(query);
  return withShop(shopId, async (tx) => {
    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(customers).where(where);
    const at = listPage(total, page, perPage);
    const rows =
      total === 0
        ? []
        : await tx
            .select({
              id: customers.id,
              name: customers.name,
              phone: customers.phone,
              email: customers.email,
              city: customers.city,
              state: customers.state,
              bought: vehicleCount("bought"),
              sold: vehicleCount("sold"),
              owned: vehicleCount("owned"),
            })
            .from(customers)
            .where(where)
            // The id keeps two customers of the same name in one order, so
            // neither shows on two pages or on none.
            .orderBy(sql`lower(${customers.name})`, asc(customers.id))
            .limit(perPage)
            .offset(at.offset);
    return {
      ...at,
      total,
      items: rows.map(({ bought, sold, owned, ...row }) => ({ ...row, vehicles: { bought, sold, owned } })),
    };
  });
}

// --- One customer -------------------------------------------------------------

export type CustomerRecord = CustomerFields & { id: string; createdAt: Date; updatedAt: Date };

export type VehicleDiagnosis = {
  id: string;
  title: string;
  status: ConversationStatus;
  // The cause the tech confirmed ("This was it"): the fix.
  fix: string | null;
  startedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type VehicleRecord = VehicleFields & {
  id: string;
  customerId: string;
  label: string;
  createdAt: Date;
  diagnoses: VehicleDiagnosis[];
};

export type CustomerDetail = { customer: CustomerRecord; vehicles: VehicleRecord[] };

const customerColumns = {
  id: customers.id,
  name: customers.name,
  phone: customers.phone,
  email: customers.email,
  addressLine1: customers.addressLine1,
  addressLine2: customers.addressLine2,
  city: customers.city,
  state: customers.state,
  postalCode: customers.postalCode,
  notes: customers.notes,
  createdAt: customers.createdAt,
  updatedAt: customers.updatedAt,
};

const vehicleColumns = {
  id: customerVehicles.id,
  customerId: customerVehicles.customerId,
  relation: customerVehicles.relation,
  relationDate: customerVehicles.relationDate,
  year: customerVehicles.year,
  make: customerVehicles.make,
  model: customerVehicles.model,
  modelNumber: customerVehicles.modelNumber,
  vin: customerVehicles.vin,
  color: customerVehicles.color,
  notes: customerVehicles.notes,
  createdAt: customerVehicles.createdAt,
};

// The diagnoses of some vehicles, newest first, by vehicle.
async function diagnosesOf(tx: ShopTransaction, vehicleIds: string[]) {
  const byVehicle = new Map<string, VehicleDiagnosis[]>();
  if (vehicleIds.length === 0) return byVehicle;
  const rows = await tx
    .select({
      vehicleId: diagnosisConversations.customerVehicleId,
      id: diagnosisConversations.id,
      title: diagnosisConversations.title,
      status: diagnosisConversations.status,
      outcome: diagnosisConversations.outcome,
      startedBy: users.name,
      createdAt: diagnosisConversations.createdAt,
      updatedAt: diagnosisConversations.updatedAt,
    })
    .from(diagnosisConversations)
    .innerJoin(users, eq(users.id, diagnosisConversations.userId))
    .where(inArray(diagnosisConversations.customerVehicleId, vehicleIds))
    .orderBy(desc(diagnosisConversations.createdAt), desc(diagnosisConversations.id));
  for (const { vehicleId, outcome, ...row } of rows) {
    const list = byVehicle.get(vehicleId!) ?? [];
    list.push({ ...row, fix: outcome?.title ?? null });
    byVehicle.set(vehicleId!, list);
  }
  return byVehicle;
}

// A customer's vehicles: the ones they have (bought or brought in) first,
// the newest deal first, then the ones they sold us.
const vehicleOrder = [
  sql`${customerVehicles.relation} = 'sold'`,
  sql`${customerVehicles.relationDate} desc nulls last`,
  desc(customerVehicles.createdAt),
  desc(customerVehicles.id),
];

// A customer with their vehicles and each vehicle's diagnoses. Null when
// it isn't the shop's.
export async function getCustomer(shopId: string, id: string): Promise<CustomerDetail | null> {
  if (!isUuid(id)) return null;
  return withShop(shopId, async (tx) => {
    const [customer] = await tx.select(customerColumns).from(customers).where(eq(customers.id, id));
    if (!customer) return null;
    const rows = await tx
      .select(vehicleColumns)
      .from(customerVehicles)
      .where(eq(customerVehicles.customerId, id))
      .orderBy(...vehicleOrder);
    const diagnoses = await diagnosesOf(
      tx,
      rows.map((row) => row.id),
    );
    return {
      customer,
      vehicles: rows.map((row) => ({ ...row, label: vehicleLabel(row), diagnoses: diagnoses.get(row.id) ?? [] })),
    };
  });
}

export type SameVin = { customerId: string; customerName: string; vehicleId: string; relation: VehicleRelation; relationDate: string | null };

export type VehicleDetail = {
  customer: { id: string; name: string };
  vehicle: VehicleRecord;
  // The same VIN on other records (traded in by one customer, bought by
  // the next).
  sameVin: SameVin[];
};

// One vehicle of a customer, with its diagnoses and the other records
// with its VIN. Null when it isn't that customer's, in this shop.
export async function getVehicle(shopId: string, customerId: string, vehicleId: string): Promise<VehicleDetail | null> {
  if (!isUuid(customerId) || !isUuid(vehicleId)) return null;
  return withShop(shopId, async (tx) => {
    const [row] = await tx
      .select({ ...vehicleColumns, customerName: customers.name })
      .from(customerVehicles)
      .innerJoin(customers, eq(customers.id, customerVehicles.customerId))
      .where(and(eq(customerVehicles.id, vehicleId), eq(customerVehicles.customerId, customerId)));
    if (!row) return null;
    const { customerName, ...vehicle } = row;
    const diagnoses = await diagnosesOf(tx, [vehicle.id]);
    const sameVin = vehicle.vin
      ? await tx
          .select({
            customerId: customers.id,
            customerName: customers.name,
            vehicleId: customerVehicles.id,
            relation: customerVehicles.relation,
            relationDate: customerVehicles.relationDate,
          })
          .from(customerVehicles)
          .innerJoin(customers, eq(customers.id, customerVehicles.customerId))
          .where(and(eq(customerVehicles.vin, vehicle.vin), ne(customerVehicles.id, vehicle.id)))
          .orderBy(sql`${customerVehicles.relationDate} desc nulls last`, desc(customerVehicles.createdAt))
      : [];
    return {
      customer: { id: customerId, name: customerName },
      vehicle: { ...vehicle, label: vehicleLabel(vehicle), diagnoses: diagnoses.get(vehicle.id) ?? [] },
      sameVin,
    };
  });
}

// --- Changing customers -----------------------------------------------------

export async function createCustomer(
  actor: CurrentUser,
  input: Record<keyof CustomerFields, unknown>,
): Promise<{ id: string } | { error: string }> {
  const checked = checkCustomer(input);
  if ("error" in checked) return checked;
  return withShop(actor.shop.id, async (tx) => {
    const [row] = await tx
      .insert(customers)
      // Always the actor's own shop, never anything from the form.
      .values({ ...checked.customer, shopId: actor.shop.id, createdByUserId: actor.id })
      .returning({ id: customers.id });
    await audit(tx, actor, "customer.created", { type: "customer", id: row.id }, { name: checked.customer.name });
    return { id: row.id };
  });
}

export async function updateCustomer(
  actor: CurrentUser,
  id: string,
  input: Record<keyof CustomerFields, unknown>,
): Promise<Result> {
  if (!isUuid(id)) return NOT_HERE;
  const checked = checkCustomer(input);
  if ("error" in checked) return checked;
  return withShop(actor.shop.id, async (tx) => {
    const [before] = await tx.select(customerColumns).from(customers).where(eq(customers.id, id)).for("update");
    if (!before) return NOT_HERE;
    const fields = changedFields(before, checked.customer);
    if (fields.length === 0) return { ok: true };
    await tx.update(customers).set(checked.customer).where(eq(customers.id, id));
    await audit(tx, actor, "customer.updated", { type: "customer", id }, { name: checked.customer.name, fields });
    return { ok: true };
  });
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// Removes a customer and their vehicles, unless a diagnosis is tied to one
// of the vehicles: diagnoses are the shop's records, and they keep theirs.
export async function removeCustomer(actor: CurrentUser, id: string): Promise<Result & { name?: string }> {
  if (!isUuid(id)) return NOT_HERE;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const [customer] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, id)).for("update");
      if (!customer) return NOT_HERE;
      const [{ diagnoses, vehicles }] = await tx
        .select({
          vehicles: sql<number>`count(distinct ${customerVehicles.id})::int`,
          diagnoses: sql<number>`count(${diagnosisConversations.id})::int`,
        })
        .from(customerVehicles)
        .leftJoin(diagnosisConversations, eq(diagnosisConversations.customerVehicleId, customerVehicles.id))
        .where(eq(customerVehicles.customerId, id));
      if (diagnoses > 0) {
        return {
          error: `${plural(diagnoses, "diagnosis is", "diagnoses are")} tied to ${customer.name}'s vehicles, so the record stays. Unlink ${diagnoses === 1 ? "it" : "them"} on the diagnosis first if this customer was added by mistake.`,
        };
      }
      await tx.delete(customers).where(eq(customers.id, id));
      await audit(tx, actor, "customer.removed", { type: "customer", id }, { name: customer.name, vehicles });
      return { ok: true as const, name: customer.name };
    });
  } catch (error) {
    // A diagnosis linked to one of the vehicles a moment ago.
    if (isForeignKeyViolation(error)) return { error: "A diagnosis is tied to one of their vehicles now, so the record stays." };
    throw error;
  }
}

// --- Changing vehicles ------------------------------------------------------

export async function addVehicle(
  actor: CurrentUser,
  customerId: string,
  input: Record<keyof VehicleFields, unknown>,
): Promise<{ id: string } | { error: string }> {
  if (!isUuid(customerId)) return NOT_HERE;
  const checked = checkVehicle(input);
  if ("error" in checked) return checked;
  return withShop(actor.shop.id, async (tx) => {
    const [customer] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId));
    if (!customer) return NOT_HERE;
    const [row] = await tx
      .insert(customerVehicles)
      .values({ ...checked.vehicle, customerId, shopId: actor.shop.id })
      .returning({ id: customerVehicles.id });
    await audit(
      tx,
      actor,
      "vehicle.added",
      { type: "customer_vehicle", id: row.id },
      { customerId, vehicle: vehicleLabel(checked.vehicle), relation: checked.vehicle.relation },
    );
    return { id: row.id };
  });
}

export async function updateVehicle(
  actor: CurrentUser,
  customerId: string,
  vehicleId: string,
  input: Record<keyof VehicleFields, unknown>,
): Promise<Result> {
  if (!isUuid(customerId) || !isUuid(vehicleId)) return VEHICLE_NOT_HERE;
  const checked = checkVehicle(input);
  if ("error" in checked) return checked;
  return withShop(actor.shop.id, async (tx) => {
    const where = and(eq(customerVehicles.id, vehicleId), eq(customerVehicles.customerId, customerId));
    const [before] = await tx.select(vehicleColumns).from(customerVehicles).where(where).for("update");
    if (!before) return VEHICLE_NOT_HERE;
    const fields = changedFields(before, checked.vehicle);
    if (fields.length === 0) return { ok: true };
    await tx.update(customerVehicles).set(checked.vehicle).where(where);
    await audit(
      tx,
      actor,
      "vehicle.updated",
      { type: "customer_vehicle", id: vehicleId },
      { customerId, vehicle: vehicleLabel(checked.vehicle), fields },
    );
    return { ok: true };
  });
}

// Removes a vehicle from a customer's record, unless a diagnosis is tied
// to it.
export async function removeVehicle(actor: CurrentUser, customerId: string, vehicleId: string): Promise<Result> {
  if (!isUuid(customerId) || !isUuid(vehicleId)) return VEHICLE_NOT_HERE;
  try {
    return await withShop(actor.shop.id, async (tx) => {
      const where = and(eq(customerVehicles.id, vehicleId), eq(customerVehicles.customerId, customerId));
      const [vehicle] = await tx.select(vehicleColumns).from(customerVehicles).where(where).for("update");
      if (!vehicle) return VEHICLE_NOT_HERE;
      const [{ diagnoses }] = await tx
        .select({ diagnoses: sql<number>`count(*)::int` })
        .from(diagnosisConversations)
        .where(eq(diagnosisConversations.customerVehicleId, vehicleId));
      if (diagnoses > 0) {
        return {
          error: `${plural(diagnoses, "diagnosis is", "diagnoses are")} tied to this vehicle, so it stays on the record. If they've sold it to you, change it to Sold to us instead.`,
        };
      }
      await tx.delete(customerVehicles).where(where);
      await audit(
        tx,
        actor,
        "vehicle.removed",
        { type: "customer_vehicle", id: vehicleId },
        { customerId, vehicle: vehicleLabel(vehicle) },
      );
      return { ok: true as const };
    });
  } catch (error) {
    if (isForeignKeyViolation(error)) return { error: "A diagnosis is tied to this vehicle now, so it stays on the record." };
    throw error;
  }
}

// --- For Diagnose -------------------------------------------------------------

const choiceColumns = {
  vehicleId: customerVehicles.id,
  customerId: customers.id,
  customerName: customers.name,
  relation: customerVehicles.relation,
  year: customerVehicles.year,
  make: customerVehicles.make,
  model: customerVehicles.model,
  modelNumber: customerVehicles.modelNumber,
  vin: customerVehicles.vin,
};

const toChoice = ({ make, ...row }: { make: string | null } & Omit<CustomerVehicleChoice, "label">): CustomerVehicleChoice => ({
  ...row,
  label: vehicleLabel({ ...row, make }),
});

export const CUSTOMER_VEHICLE_SUGGESTIONS = 8;

// Customers' vehicles for Diagnose's picker, by the customer's name or
// phone number, or the vehicle's year, make, model, model number or VIN:
// every word somewhere, any case. Vehicles they have come first, ones sold
// to us after. Results show only whose a vehicle is and what it is.
export async function searchCustomerVehicles(shopId: string, query: string): Promise<CustomerVehicleChoice[]> {
  const words = listSearchWords(query);
  if (words.length === 0) return [];
  const text = sql`concat_ws(' ',
    ${customers.name}, ${customers.phone}, regexp_replace(coalesce(${customers.phone}, ''), '[^0-9]', '', 'g'),
    ${customerVehicles.year}, ${customerVehicles.make}, ${customerVehicles.model}, ${customerVehicles.modelNumber},
    ${customerVehicles.vin})`;
  const patterns = sql.join(
    words.map((word) => sql`${containsPattern(word)}`),
    sql`, `,
  );
  return withShop(shopId, async (tx) => {
    const rows = await tx
      .select(choiceColumns)
      .from(customerVehicles)
      .innerJoin(customers, eq(customers.id, customerVehicles.customerId))
      .where(sql`${text} ilike all (array[${patterns}]::text[])`)
      .orderBy(sql`${customerVehicles.relation} = 'sold'`, sql`lower(${customers.name})`, desc(customerVehicles.createdAt))
      .limit(CUSTOMER_VEHICLE_SUGGESTIONS);
    return rows.map(toChoice);
  });
}

// One customer's vehicle as Diagnose picks it (from ?vehicle= on a new
// diagnosis). Null when it isn't the shop's.
export async function getVehicleChoice(shopId: string, vehicleId: string): Promise<CustomerVehicleChoice | null> {
  if (!isUuid(vehicleId)) return null;
  return withShop(shopId, async (tx) => findChoice(tx, vehicleId));
}

export async function findChoice(tx: ShopTransaction, vehicleId: string): Promise<CustomerVehicleChoice | null> {
  const [row] = await tx
    .select(choiceColumns)
    .from(customerVehicles)
    .innerJoin(customers, eq(customers.id, customerVehicles.customerId))
    .where(eq(customerVehicles.id, vehicleId));
  return row ? toChoice(row) : null;
}

// Whose vehicle a diagnosis is for, as its screen shows it.
export async function customerOf(shopId: string, vehicleId: string | null): Promise<ConversationCustomer | null> {
  if (!vehicleId) return null;
  const choice = await withShop(shopId, (tx) => findChoice(tx, vehicleId));
  return choice && conversationCustomer(choice);
}
