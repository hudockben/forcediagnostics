// System Admin > Customers: the rules for what a customer and a vehicle
// hold (src/lib/customer-rules.ts), the records themselves
// (src/lib/customers.ts) staying inside their shop, and Diagnose's link to a
// customer's vehicle: starting a diagnosis on one, linking one later, the
// customer's record listing each diagnosis with its fix, and a vehicle with
// diagnoses staying on the record.
// Needs DATABASE_URL pointing at a disposable Postgres database; run with
// `npm test`, which migrates it first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { systemDb, withShop } from "../src/db";
import { auditLog, customerVehicles, customers, diagnosisConversations, diagnosisTurns, shops, users } from "../src/db/schema";
import {
  addressLines,
  checkCustomer,
  checkVehicle,
  diagnoseStartFields,
  normalizeEmail,
  normalizePhone,
  vehicleLabel,
  type CustomerFields,
  type VehicleFields,
} from "../src/lib/customer-rules";
import {
  addVehicle,
  createCustomer,
  getCustomer,
  getVehicle,
  getVehicleChoice,
  listCustomers,
  removeCustomer,
  removeVehicle,
  searchCustomerVehicles,
  updateCustomer,
  updateVehicle,
} from "../src/lib/customers";
import {
  carryOver,
  getConversation,
  isProblem,
  linkCustomerVehicle,
  listConversations,
  markCause,
  prepareTurn,
} from "../src/lib/diagnose";
import { ADMIN_SECTIONS, allows, can, needsPasswordSession } from "../src/lib/permissions";
import type { CurrentUser } from "../src/lib/session";

const suffix = randomUUID().slice(0, 6).replace(/-/g, "");
const shopIds: string[] = [];

async function createShop(code: string) {
  const [shop] = await systemDb
    .insert(shops)
    .values({ code, name: `Shop ${code}` })
    .returning({ id: shops.id, code: shops.code, name: shops.name });
  shopIds.push(shop.id);
  return shop;
}

async function createUser(shop: CurrentUser["shop"], role: CurrentUser["role"], name: string): Promise<CurrentUser> {
  const id = randomUUID();
  const username = `${name.toLowerCase()}${randomUUID().slice(0, 4)}`;
  await systemDb.insert(users).values({
    id,
    shopId: shop.id,
    role,
    name,
    username: `${shop.code}.${username}`,
    displayUsername: username,
    email: `${randomUUID()}@no-email.invalid`,
  });
  return { id, name, username, role, shop, bay: null };
}

const blankCustomer: Record<keyof CustomerFields, string> = {
  name: "",
  phone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  notes: "",
};

const blankVehicle: Record<keyof VehicleFields, string> = {
  relation: "bought",
  relationDate: "",
  year: "",
  make: "",
  model: "",
  modelNumber: "",
  vin: "",
  color: "",
  notes: "",
};

// A real VIN shape with a matching check digit (49 CFR 565).
const VIN = "1HGCM82633A004352";
const OTHER_VIN = "4XASEE57XPA123456";

let writer: CurrentUser;
let tech: CurrentUser;
let otherShop: CurrentUser;

before(async () => {
  const shop = await createShop(`cu${suffix}`);
  const other = await createShop(`cx${suffix}`);
  writer = await createUser(shop, "service_writer", "Sam");
  tech = await createUser(shop, "tech", "Mike");
  otherShop = await createUser(other, "admin", "Olga");
});

after(async () => {
  for (const id of shopIds) await systemDb.delete(shops).where(eq(shops.id, id));
  await systemDb.$client.end();
});

async function newCustomer(actor: CurrentUser, fields: Partial<Record<keyof CustomerFields, string>>) {
  const result = await createCustomer(actor, { ...blankCustomer, ...fields });
  assert.ok("id" in result, JSON.stringify(result));
  return result.id;
}

async function newVehicle(actor: CurrentUser, customerId: string, fields: Partial<Record<keyof VehicleFields, string>>) {
  const result = await addVehicle(actor, customerId, { ...blankVehicle, ...fields });
  assert.ok("id" in result, JSON.stringify(result));
  return result.id;
}

describe("the rules for a customer", () => {
  test("phone numbers are tidied the way the shop writes them", () => {
    assert.deepEqual(normalizePhone("555.123.4567"), { phone: "(555) 123-4567" });
    assert.deepEqual(normalizePhone("+1 (555) 123-4567"), { phone: "(555) 123-4567" });
    assert.deepEqual(normalizePhone("15551234567"), { phone: "(555) 123-4567" });
    assert.deepEqual(normalizePhone("555-123-4567 ext. 12"), { phone: "(555) 123-4567 x12" });
    // From abroad, or short local numbers: as typed.
    assert.deepEqual(normalizePhone("+44 20 7946 0958"), { phone: "+44 20 7946 0958" });
    assert.deepEqual(normalizePhone("123-4567"), { phone: "123-4567" });
    assert.deepEqual(normalizePhone("  "), { phone: "" });
    assert.ok("error" in normalizePhone("call after 5"));
    assert.ok("error" in normalizePhone("12345"));
  });

  test("an email needs an @ and a domain", () => {
    assert.deepEqual(normalizeEmail(" jo@example.com "), { email: "jo@example.com" });
    assert.deepEqual(normalizeEmail(""), { email: "" });
    assert.ok("error" in normalizeEmail("jo@example"));
    assert.ok("error" in normalizeEmail("jo example.com"));
  });

  test("only the name is needed; the rest is tidied and blank is null", () => {
    assert.deepEqual(checkCustomer({ ...blankCustomer }), { error: "Enter the customer's name." });
    const checked = checkCustomer({
      ...blankCustomer,
      name: "  Jo   Smith ",
      phone: "5551234567",
      state: "pa",
      postalCode: "k1a 0b1",
      notes: "Line one\r\nLine two",
    });
    assert.ok("customer" in checked);
    assert.deepEqual(checked.customer, {
      name: "Jo Smith",
      phone: "(555) 123-4567",
      email: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: "PA",
      postalCode: "K1A 0B1",
      notes: "Line one\nLine two",
    });
    assert.ok("error" in checkCustomer({ ...blankCustomer, name: "x".repeat(121) }));
    assert.ok("error" in checkCustomer({ ...blankCustomer, name: "Jo", email: "nope" }));
  });

  test("the address reads like an envelope", () => {
    assert.deepEqual(
      addressLines({ addressLine1: "12 Main St", addressLine2: null, city: "Altoona", state: "PA", postalCode: "16601" }),
      ["12 Main St", "Altoona, PA 16601"],
    );
    assert.deepEqual(addressLines({ addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null }), []);
  });
});

describe("the rules for a vehicle", () => {
  test("a vehicle needs a model, a model number or a whole VIN", () => {
    assert.ok("error" in checkVehicle({ ...blankVehicle, year: "2021", make: "Polaris" }));
    assert.ok("vehicle" in checkVehicle({ ...blankVehicle, model: "Sportsman 850" }));
    assert.ok("vehicle" in checkVehicle({ ...blankVehicle, modelNumber: "a21sxz85a1" }));
    assert.ok("vehicle" in checkVehicle({ ...blankVehicle, vin: VIN }));
  });

  test("what's typed is tidied, and the date only goes with bought and sold", () => {
    const bought = checkVehicle({
      ...blankVehicle,
      relationDate: "2024-06-24",
      year: "2021",
      make: " Polaris ",
      model: "Sportsman  850",
      modelNumber: "a21 sxz85a1",
      vin: `vin: ${VIN.toLowerCase()}`,
    });
    assert.ok("vehicle" in bought);
    assert.deepEqual(bought.vehicle, {
      relation: "bought",
      relationDate: "2024-06-24",
      year: 2021,
      make: "Polaris",
      model: "Sportsman 850",
      modelNumber: "A21SXZ85A1",
      vin: VIN,
      color: null,
      notes: null,
    });
    const owned = checkVehicle({ ...blankVehicle, relation: "owned", relationDate: "2024-06-24", model: "RZR" });
    assert.ok("vehicle" in owned);
    assert.equal(owned.vehicle.relationDate, null);
  });

  test("bad values are refused with a reason", () => {
    assert.ok("error" in checkVehicle({ ...blankVehicle, relation: "leased", model: "RZR" }));
    assert.ok("error" in checkVehicle({ ...blankVehicle, relationDate: "2024-02-30", model: "RZR" }));
    assert.ok("error" in checkVehicle({ ...blankVehicle, year: "21", model: "RZR" }));
    assert.ok("error" in checkVehicle({ ...blankVehicle, year: "1890", model: "RZR" }));
    assert.ok("error" in checkVehicle({ ...blankVehicle, modelNumber: "Z19/VDE" }));
    // I, O and Q never appear in a VIN; part of one goes in the notes.
    assert.ok("error" in checkVehicle({ ...blankVehicle, vin: "1HGCM82633A00435O" }));
    const partial = checkVehicle({ ...blankVehicle, vin: "A004352" });
    assert.ok("error" in partial && partial.error.includes("notes"));
  });

  test("a vehicle is called by its year, make and model, or what else there is", () => {
    const none = { year: null, make: null, model: null, modelNumber: null, vin: null };
    assert.equal(vehicleLabel({ ...none, year: 2021, make: "Polaris", model: "Sportsman 850" }), "2021 Polaris Sportsman 850");
    assert.equal(vehicleLabel({ ...none, year: 2019, modelNumber: "Z19VDE99AM" }), "2019 Z19VDE99AM");
    assert.equal(vehicleLabel({ ...none, vin: VIN }), `VIN ${VIN}`);
    assert.equal(vehicleLabel(none), "Vehicle");
  });

  test("Diagnose's quick form starts with the model number, else the year and model", () => {
    assert.deepEqual(diagnoseStartFields({ year: 2019, model: "RZR XP 1000", modelNumber: "Z19VDE99AM", vin: VIN }), {
      modelNumber: "Z19VDE99AM",
      vin: VIN,
      model: "",
    });
    assert.deepEqual(diagnoseStartFields({ year: 2021, model: "Sportsman 850", modelNumber: null, vin: null }), {
      modelNumber: "",
      vin: "",
      model: "2021 Sportsman 850",
    });
  });
});

describe("who can use Customers", () => {
  test("service writers, managers and admins, signed in with a password", () => {
    assert.ok(can("service_writer", "repair_orders.intake"));
    assert.ok(can("manager", "repair_orders.intake"));
    assert.ok(can("admin", "repair_orders.intake"));
    assert.ok(!can("tech", "repair_orders.intake"));
    assert.ok(!can("parts", "repair_orders.intake"));
    // Contact details stay off the shared bay tablets.
    assert.ok(needsPasswordSession("repair_orders.intake"));
    const bay = { deviceId: "d", deviceName: "Bay 1", sessionId: "s" };
    assert.ok(!allows({ role: "manager", bay }, "repair_orders.intake"));
    assert.equal(ADMIN_SECTIONS.find((section) => section.href === "/admin/customers")?.capability, "repair_orders.intake");
  });
});

describe("customers", () => {
  test("added, listed A to Z, found by any of their details, and paged", async () => {
    const zed = await newCustomer(writer, { name: "Zed Okafor", phone: "814-555-0100", city: "Altoona", state: "pa" });
    const amy = await newCustomer(writer, { name: "amy Brandt", email: "amy@example.com" });
    await newVehicle(writer, zed, { model: "Ranger XP 1000", vin: OTHER_VIN });
    const all = await listCustomers(writer.shop.id, { perPage: 100 });
    const names = all.items.map((item) => item.name);
    assert.ok(names.indexOf("amy Brandt") < names.indexOf("Zed Okafor"), "A to Z, any case");
    const found = async (query: string) => (await listCustomers(writer.shop.id, { query, perPage: 100 })).items.map((item) => item.id);
    assert.deepEqual(await found("okafor altoona"), [zed]);
    assert.deepEqual(await found("8145550100"), [zed], "the phone's digits on their own");
    assert.deepEqual(await found("amy@example"), [amy]);
    assert.deepEqual(await found("ranger"), [zed], "their vehicles' models");
    assert.deepEqual(await found(OTHER_VIN.slice(-6)), [zed], "their vehicles' VINs");
    assert.deepEqual(await found("nobody-here"), []);
    const zedRow = all.items.find((item) => item.id === zed)!;
    assert.deepEqual(zedRow.vehicles, { bought: 1, sold: 0, owned: 0 });
    assert.equal(zedRow.state, "PA");

    const first = await listCustomers(writer.shop.id, { perPage: 1 });
    const second = await listCustomers(writer.shop.id, { perPage: 1, page: 2 });
    assert.equal(first.total, all.total);
    assert.notEqual(first.items[0].id, second.items[0].id);
    const past = await listCustomers(writer.shop.id, { perPage: 1, page: 999 });
    assert.equal(past.page, past.pages, "a page past the end shows the last");
  });

  test("edits are saved and audited by field name, never by value", async () => {
    const id = await newCustomer(writer, { name: "Pat Lee" });
    const saved = await updateCustomer(writer, id, { ...blankCustomer, name: "Pat Lee", phone: "5551112222", city: "Tyrone" });
    assert.deepEqual(saved, { ok: true });
    const detail = await getCustomer(writer.shop.id, id);
    assert.equal(detail?.customer.phone, "(555) 111-2222");
    assert.equal(detail?.customer.city, "Tyrone");
    const [entry] = await systemDb
      .select()
      .from(auditLog)
      .where(sql`${auditLog.targetId} = ${id} and ${auditLog.action} = 'customer.updated'`);
    assert.deepEqual(entry.details, { name: "Pat Lee", fields: ["phone", "city"] });
    assert.ok(!JSON.stringify(entry.details).includes("555"));
    // Saving it unchanged writes nothing.
    await updateCustomer(writer, id, { ...blankCustomer, name: "Pat Lee", phone: "(555) 111-2222", city: "Tyrone" });
    const entries = await systemDb.select().from(auditLog).where(eq(auditLog.targetId, id));
    assert.equal(entries.length, 2);
  });

  test("vehicles are added, ordered (theirs first, sold last), edited and removed", async () => {
    const id = await newCustomer(writer, { name: "Lou Grant" });
    const sold = await newVehicle(writer, id, { relation: "sold", relationDate: "2025-03-01", model: "Sportsman 570" });
    const bought = await newVehicle(writer, id, { relation: "bought", relationDate: "2025-03-01", year: "2025", make: "Polaris", model: "RZR XP 1000", vin: VIN });
    const owned = await newVehicle(writer, id, { relation: "owned", modelNumber: "Z19VDE99AM" });
    const detail = await getCustomer(writer.shop.id, id);
    assert.deepEqual(
      detail?.vehicles.map((vehicle) => vehicle.id),
      [bought, owned, sold],
    );
    assert.equal(detail?.vehicles[0].label, "2025 Polaris RZR XP 1000");

    assert.deepEqual(await updateVehicle(writer, id, owned, { ...blankVehicle, relation: "owned", modelNumber: "Z19VDE99AM", color: "Red" }), { ok: true });
    assert.equal((await getVehicle(writer.shop.id, id, owned))?.vehicle.color, "Red");
    // Only through its own customer.
    const someoneElse = await newCustomer(writer, { name: "Not Lou" });
    assert.equal(await getVehicle(writer.shop.id, someoneElse, owned), null);
    assert.ok("error" in (await updateVehicle(writer, someoneElse, owned, { ...blankVehicle, model: "X" })));
    assert.ok("error" in (await removeVehicle(writer, someoneElse, owned)));

    assert.deepEqual(await removeVehicle(writer, id, sold), { ok: true });
    assert.equal((await getCustomer(writer.shop.id, id))?.vehicles.length, 2);
  });

  test("the same VIN on another customer's record is shown", async () => {
    const seller = await newCustomer(writer, { name: "Trade In" });
    const buyer = await newCustomer(writer, { name: "Next Owner" });
    const tradeIn = await newVehicle(writer, seller, { relation: "sold", relationDate: "2025-01-10", model: "General 1000", vin: "3NSVDE99XKF000001" });
    const resold = await newVehicle(writer, buyer, { relation: "bought", relationDate: "2025-02-15", model: "General 1000", vin: "3NSVDE99XKF000001" });
    const detail = await getVehicle(writer.shop.id, buyer, resold);
    assert.deepEqual(
      detail?.sameVin.map((other) => [other.customerName, other.vehicleId, other.relation]),
      [["Trade In", tradeIn, "sold"]],
    );
  });

  test("removing a customer removes their vehicles", async () => {
    const id = await newCustomer(writer, { name: "Gone Soon" });
    const vehicle = await newVehicle(writer, id, { model: "Scrambler" });
    const removed = await removeCustomer(writer, id);
    assert.ok("ok" in removed && removed.name === "Gone Soon");
    assert.equal(await getCustomer(writer.shop.id, id), null);
    const left = await systemDb.select().from(customerVehicles).where(eq(customerVehicles.id, vehicle));
    assert.equal(left.length, 0);
  });
});

describe("customers stay inside their shop", () => {
  test("another shop can't see, change or remove them", async () => {
    const id = await newCustomer(writer, { name: "Private Person", phone: "5559998888" });
    const vehicle = await newVehicle(writer, id, { model: "Ranger" });
    assert.equal(await getCustomer(otherShop.shop.id, id), null);
    assert.equal(await getVehicle(otherShop.shop.id, id, vehicle), null);
    assert.ok(!(await listCustomers(otherShop.shop.id, { perPage: 1000 })).items.some((item) => item.id === id));
    assert.deepEqual(await searchCustomerVehicles(otherShop.shop.id, "private"), []);
    assert.equal(await getVehicleChoice(otherShop.shop.id, vehicle), null);
    assert.ok("error" in (await updateCustomer(otherShop, id, { ...blankCustomer, name: "Hijacked" })));
    assert.ok("error" in (await removeCustomer(otherShop, id)));
    assert.ok("error" in (await addVehicle(otherShop, id, { ...blankVehicle, model: "Planted" })));
    assert.equal((await getCustomer(writer.shop.id, id))?.customer.name, "Private Person");
  });

  test("row-level security holds even when a query forgets the shop", async () => {
    await newCustomer(writer, { name: "Shop A Only" });
    const seen = await withShop(otherShop.shop.id, (tx) => tx.select({ shopId: customers.shopId }).from(customers));
    assert.ok(seen.every((row) => row.shopId === otherShop.shop.id));
    const vehicles = await withShop(otherShop.shop.id, (tx) => tx.select({ shopId: customerVehicles.shopId }).from(customerVehicles));
    assert.ok(vehicles.every((row) => row.shopId === otherShop.shop.id));
  });

  test("a vehicle can't be tied to another shop's customer, or moved to another customer", async () => {
    const id = await newCustomer(writer, { name: "Fixed Owner" });
    const vehicle = await newVehicle(writer, id, { model: "RZR" });
    // As the other shop, naming shop A's customer: the composite foreign key
    // (customer, shop) has no such pair.
    await assert.rejects(
      withShop(otherShop.shop.id, (tx) =>
        tx.insert(customerVehicles).values({ shopId: otherShop.shop.id, customerId: id, relation: "bought", model: "Sneaky" }),
      ),
    );
    const other = await newCustomer(writer, { name: "Other Owner" });
    const permissionDenied = (error: unknown) => /permission denied/.test(String((error as { cause?: unknown }).cause));
    await assert.rejects(
      withShop(writer.shop.id, (tx) => tx.update(customerVehicles).set({ customerId: other }).where(eq(customerVehicles.id, vehicle))),
      permissionDenied,
    );
    await assert.rejects(
      withShop(writer.shop.id, (tx) => tx.update(customers).set({ shopId: otherShop.shop.id }).where(eq(customers.id, id))),
      permissionDenied,
    );
  });
});

describe("Diagnose and customers' vehicles", () => {
  test("Diagnose finds a customer's vehicle by name, phone, model or VIN, showing no contact details", async () => {
    const id = await newCustomer(writer, { name: "Dana Whitfield", phone: "814-555-0199", email: "dana@example.com" });
    const vehicle = await newVehicle(writer, id, { year: "2021", make: "Polaris", model: "Sportsman 850", modelNumber: "A21SXZ85A1", vin: VIN });
    const ids = async (query: string) => (await searchCustomerVehicles(tech.shop.id, query)).map((choice) => choice.vehicleId);
    assert.ok((await ids("whitfield")).includes(vehicle));
    assert.ok((await ids("8145550199")).includes(vehicle));
    assert.ok((await ids("dana sportsman")).includes(vehicle));
    assert.ok((await ids(VIN.slice(-8))).includes(vehicle));
    assert.deepEqual(await ids(""), []);
    const [choice] = await searchCustomerVehicles(tech.shop.id, "whitfield");
    assert.equal(choice.label, "2021 Polaris Sportsman 850");
    assert.ok(!JSON.stringify(choice).includes("dana@example.com"));
    assert.ok(!JSON.stringify(choice).includes("555"));
  });

  test("a diagnosis started on a customer's vehicle is listed on their record with its fix", async () => {
    const id = await newCustomer(writer, { name: "Rhett Carver" });
    const vehicle = await newVehicle(writer, id, { year: "2019", model: "RZR XP 1000", modelNumber: "Z19VDE99AM" });
    const prepared = await prepareTurn(tech, { start: { complaint: "Misfires under load", customerVehicle: vehicle } });
    assert.ok(!isProblem(prepared), JSON.stringify(prepared));
    const conversationId = prepared.conversation.id;
    assert.equal(prepared.conversation.customerVehicleId, vehicle);
    assert.deepEqual(prepared.conversationView.customer, {
      vehicleId: vehicle,
      customerId: id,
      customerName: "Rhett Carver",
      label: "2019 RZR XP 1000",
    });
    // Nothing about the customer goes to Claude.
    assert.ok(!JSON.stringify(prepared.history).includes("Rhett"));
    assert.ok(!prepared.turn.techText.includes("Rhett"));
    assert.ok(!prepared.notes.join(" ").includes("Rhett"));

    // The turn would run Claude; mark it done with a reply so a cause can
    // be confirmed, as the tech would.
    await systemDb
      .update(diagnosisTurns)
      .set({
        status: "done",
        history: [],
        reply: {
          message: "Check the coil.",
          likelyCauses: [{ title: "Ignition coil breaking down", system: "ignition", likelihood: "high", why: "", status: "open", sources: [] }],
          nextChecks: [],
          safety: [],
          questions: [],
        } as never,
      })
      .where(eq(diagnosisTurns.id, prepared.turn.id));
    const marked = await markCause(tech, { conversationId, turnId: prepared.turn.id, index: 0, verdict: "confirmed" });
    assert.ok(!("error" in marked), JSON.stringify(marked));

    const detail = await getCustomer(writer.shop.id, id);
    const [diagnosis] = detail!.vehicles[0].diagnoses;
    assert.equal(diagnosis.id, conversationId);
    // The vehicle's model number goes in the quick form (the browser fills
    // it in); the server only ties the diagnosis to the vehicle.
    assert.equal(diagnosis.title, "Misfires under load");
    assert.equal(diagnosis.status, "solved");
    assert.equal(diagnosis.fix, "Ignition coil breaking down");
    assert.equal(diagnosis.startedBy, "Mike");

    // The Diagnose list says whose it is and finds it by the customer.
    const list = await listConversations(tech.shop.id, { query: "carver", perPage: 100 });
    assert.deepEqual(
      list.items.map((item) => [item.id, item.customer]),
      [[conversationId, "Rhett Carver"]],
    );
    // A diagnosis carried on from it keeps the customer.
    const carried = await carryOver(tech, conversationId);
    assert.equal(carried?.customer?.vehicleId, vehicle);
    const next = await prepareTurn(tech, { start: { from: conversationId, message: "Still misfiring" } });
    assert.ok(!isProblem(next));
    assert.equal(next.conversation.customerVehicleId, vehicle);
    // Unless the tech took it off.
    const none = await prepareTurn(tech, { start: { from: conversationId, message: "Someone else's", customerVehicle: "" } });
    assert.ok(!isProblem(none));
    assert.equal(none.conversation.customerVehicleId, null);
  });

  test("another shop's vehicle can't be picked or linked", async () => {
    const theirs = await newCustomer(otherShop, { name: "Elsewhere" });
    const theirVehicle = await newVehicle(otherShop, theirs, { model: "Ranger" });
    const refused = await prepareTurn(tech, { start: { complaint: "No start", customerVehicle: theirVehicle } });
    assert.ok(isProblem(refused));
    assert.equal(refused.status, 404);
    const started = await prepareTurn(tech, { start: { complaint: "No start" } });
    assert.ok(!isProblem(started));
    assert.ok("error" in (await linkCustomerVehicle(tech, { conversationId: started.conversation.id, vehicleId: theirVehicle })));
    // And the database refuses it too, whatever the code does.
    await assert.rejects(
      withShop(tech.shop.id, (tx) =>
        tx
          .update(diagnosisConversations)
          .set({ customerVehicleId: theirVehicle })
          .where(eq(diagnosisConversations.id, started.conversation.id)),
      ),
    );
  });

  test("a diagnosis can be linked later, and a vehicle with diagnoses stays on the record", async () => {
    const id = await newCustomer(writer, { name: "Late Link" });
    const vehicle = await newVehicle(writer, id, { model: "Sportsman 570" });
    const started = await prepareTurn(tech, { start: { complaint: "Belt squeal" } });
    assert.ok(!isProblem(started));
    const conversationId = started.conversation.id;
    assert.equal(started.conversationView.customer, null);

    const linked = await linkCustomerVehicle(tech, { conversationId, vehicleId: vehicle });
    assert.deepEqual(linked, { customer: { vehicleId: vehicle, customerId: id, customerName: "Late Link", label: "Sportsman 570" } });
    assert.equal((await getConversation(tech, conversationId))?.conversation.customer?.customerName, "Late Link");

    const keepVehicle = await removeVehicle(writer, id, vehicle);
    assert.ok("error" in keepVehicle && keepVehicle.error.includes("1 diagnosis is tied"));
    const keepCustomer = await removeCustomer(writer, id);
    assert.ok("error" in keepCustomer && keepCustomer.error.includes("1 diagnosis is tied"));

    assert.deepEqual(await linkCustomerVehicle(tech, { conversationId, vehicleId: null }), { customer: null });
    assert.deepEqual(await removeVehicle(writer, id, vehicle), { ok: true });
    assert.ok("ok" in (await removeCustomer(writer, id)));
  });
});
