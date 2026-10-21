// Staff roles. Kept free of database imports so browser code can use it.
export const ROLES = ["tech", "service_writer", "parts", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];
