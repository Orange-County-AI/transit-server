/**
 * The seam that keeps commercial metering out of the open-source server.
 *
 * This distribution ships exactly one implementation — {@link unmetered} — and
 * it denies nothing: no plan tiers, no quotas, no license check. The hosted
 * service layers its own implementation over the identical core by passing one
 * to `createApp()` (see `src/index.ts`) and by subclassing the Durable Objects
 * that meter message volume.
 *
 * The seam is an injected object rather than an `if (billingEnforced(env))`
 * branch inside each handler because the branch form forces the metering code
 * to exist in every build. An injected object lets the whole billing
 * implementation live outside this repository while the request handlers below
 * stay byte-identical between distributions.
 */

/** The resources a deployment may cap. */
export type EntitlementLimit = "hosts" | "integrations";

/**
 * A refusal. Serialized verbatim as the HTTP 402 body alongside
 * `{ error: "plan_limit" }`, so field names are part of the API contract.
 */
export type PlanDenial = {
  limit: EntitlementLimit;
  plan: string;
  allowed: number;
};

export type Entitlements = {
  /** Non-null refuses `POST /api/hosts/enroll`. */
  hostDenial(env: Env, org: string): Promise<PlanDenial | null>;
  /** Non-null refuses `POST /api/integrations`. */
  integrationDenial(env: Env, org: string): Promise<PlanDenial | null>;
};

/** Allows everything. The only implementation the open-source server ships. */
export const unmetered: Entitlements = {
  async hostDenial(): Promise<PlanDenial | null> {
    return null;
  },
  async integrationDenial(): Promise<PlanDenial | null> {
    return null;
  },
};
