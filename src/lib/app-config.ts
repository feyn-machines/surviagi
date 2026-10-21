/**
 * Whether the signed-in features exist in this process (administrators are rows of `app.admins`, see `isAdminUser`).
 * No imports: the unit tests load this source directly.
 */
type Env = Record<string, string | undefined>;

const REQUIRED = ["APP_DATABASE_URL", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

/** Sign-in, submissions and subscriptions need all five; without them the site is the public pages only. */
export function appEnabled(env: Env = process.env): boolean {
  return REQUIRED.every((key) => Boolean(env[key]));
}
