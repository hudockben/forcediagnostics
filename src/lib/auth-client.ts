import { createAuthClient } from "better-auth/client";
import { usernameClient } from "better-auth/client/plugins";

// Browser-side calls go through /api/auth, where Better Auth applies its
// sign-in rate limits.
export const authClient = createAuthClient({ plugins: [usernameClient()] });
