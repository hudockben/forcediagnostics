import type { Role } from "@/lib/roles";

// What each role can do, from the project plan. Server code checks these with
// can(); the System Admin > Permissions page shows the same table, so the two
// never drift apart. Admins can do everything managers can.

export const ROLE_LABELS: Record<Role, string> = {
  tech: "Tech",
  service_writer: "Service writer",
  parts: "Parts",
  manager: "Manager",
  admin: "Admin",
};

export const ROLE_SUMMARIES: Record<Role, string> = {
  tech: "Diagnostic workspace and assigned repair orders. No pricing changes.",
  service_writer: "Intake, estimates and customer communication.",
  parts: "Inventory and parts imports.",
  manager: "Everything at their location, KPIs and AI accuracy.",
  admin: "Everything, plus staff accounts, labor rates, the knowledge base and diagrams.",
};

export const CAPABILITIES = [
  {
    key: "diagnostics.work",
    label: "Diagnostic workspace",
    detail: "Codes, uploads, AI chat, tiered causes, test results",
    roles: ["tech", "manager", "admin"],
  },
  {
    key: "library.read",
    label: "Manual library",
    detail: "Search and read the shop's service and owner manuals",
    roles: ["tech", "service_writer", "parts", "manager", "admin"],
  },
  {
    key: "repair_orders.intake",
    label: "Repair order intake",
    detail: "Customers, units, complaints and write-ups",
    roles: ["service_writer", "manager", "admin"],
  },
  {
    key: "estimates.manage",
    label: "Estimates and approvals",
    detail: "Build estimates and send them to customers",
    roles: ["service_writer", "manager", "admin"],
  },
  {
    key: "pricing.change",
    label: "Change pricing",
    detail: "Override part prices and labor on an estimate",
    roles: ["manager", "admin"],
  },
  {
    key: "parts.manage",
    label: "Parts and inventory",
    detail: "Stock, vendors and parts imports",
    roles: ["parts", "manager", "admin"],
  },
  {
    key: "reports.kpis",
    label: "Shop board and KPIs",
    detail: "Repair orders by stage, days in shop, AI accuracy",
    roles: ["manager", "admin"],
  },
  {
    key: "bay_tablets.manage",
    label: "Bay tablets",
    detail: "Pair and remove shared bay tablets, unlock locked PINs",
    roles: ["manager", "admin"],
  },
  {
    key: "accounts.manage",
    label: "Staff accounts",
    detail: "Add staff, change roles, reset passwords, disable accounts",
    roles: ["admin"],
  },
  {
    key: "settings.manage",
    label: "Shop settings",
    detail: "Labor rates, knowledge base and diagram builder",
    roles: ["admin"],
  },
] as const satisfies readonly {
  key: string;
  label: string;
  detail: string;
  roles: readonly Role[];
}[];

export type Capability = (typeof CAPABILITIES)[number]["key"];

export function can(role: Role, capability: Capability) {
  const entry = CAPABILITIES.find((c) => c.key === capability);
  return (entry?.roles as readonly Role[] | undefined)?.includes(role) ?? false;
}

// Admin areas need a password sign-in; a PIN on a bay tablet isn't enough.
const PASSWORD_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "accounts.manage",
  "bay_tablets.manage",
  "settings.manage",
]);

export function needsPasswordSession(capability: Capability) {
  return PASSWORD_ONLY.has(capability);
}

// The System Admin sections, in menu order. The tab opens the first one the
// user may use.
export const ADMIN_SECTIONS: { href: string; label: string; capability: Capability }[] = [
  { href: "/admin/accounts", label: "Accounts", capability: "accounts.manage" },
  { href: "/admin/bay-tablets", label: "Bay tablets", capability: "bay_tablets.manage" },
  { href: "/admin/manuals", label: "Manuals", capability: "settings.manage" },
  { href: "/admin/permissions", label: "Permissions", capability: "accounts.manage" },
];
