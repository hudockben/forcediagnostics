import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { withShop } from "@/db";
import { shops, type Role } from "@/db/schema";
import { getAuth } from "@/lib/auth";

export type CurrentUser = {
  id: string;
  name: string;
  username: string;
  role: Role;
  shop: { id: string; code: string; name: string };
};

// The signed-in user and their shop. Redirects to sign-in when there is no
// valid session, so pages can rely on getting a user back.
export async function getCurrentUser(): Promise<CurrentUser> {
  // Read the request first: it ends prerendering, so the build never starts auth.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/");

  const { user } = session;
  // No filter needed: row-level security only returns the user's own shop.
  const [shop] = await withShop(user.shopId, (tx) =>
    tx.select({ id: shops.id, code: shops.code, name: shops.name }).from(shops),
  );
  if (!shop) redirect("/");

  return {
    id: user.id,
    name: user.name,
    username: user.displayUsername ?? user.username ?? "",
    role: user.role as Role,
    shop,
  };
}
