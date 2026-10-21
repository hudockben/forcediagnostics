import "server-only";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { withShop } from "@/db";
import { shops, users, type Role } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { can, type Capability } from "@/lib/permissions";

export type CurrentUser = {
  id: string;
  name: string;
  username: string;
  role: Role;
  shop: { id: string; code: string; name: string };
};

// The signed-in user and their shop, looked up once per request. Redirects to
// sign-in when there is no valid session or the account has been disabled, so
// pages and server actions can rely on getting a user back.
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  // Read the request first: it ends prerendering, so the build never starts auth.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/");

  // Role and disabled state come from the database on every request, so an
  // admin's change takes effect straight away. Row-level security limits both
  // queries to the user's own shop.
  const record = await withShop(session.user.shopId, async (tx) => {
    const [shop] = await tx
      .select({ id: shops.id, code: shops.code, name: shops.name })
      .from(shops);
    const [user] = await tx
      .select({
        name: users.name,
        displayUsername: users.displayUsername,
        role: users.role,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.id, session.user.id));
    return shop && user ? { shop, user } : null;
  });
  if (!record || record.user.disabledAt) redirect("/");

  return {
    id: session.user.id,
    name: record.user.name,
    username: record.user.displayUsername ?? session.user.username ?? "",
    role: record.user.role,
    shop: record.shop,
  };
});

// For pages and server actions that need a permission: sends anyone without
// it back to the Home tab.
export async function requireCapability(capability: Capability): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!can(user.role, capability)) redirect("/home");
  return user;
}
