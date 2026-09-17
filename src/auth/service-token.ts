import type { IncomingHttpHeaders } from "node:http";
import { findOrCreateTenant, findTenantByName } from "../store/tenants.js";

/** Header naming the tenant, set by the LiteLLM proxy. */
export const TENANT_HEADER = "intent-router-tenant";
/** Header carrying the shared service token, set by the LiteLLM proxy. */
export const ROUTER_TOKEN_HEADER = "intent-router-token";

export type ServiceTokenConfig = {
  LITELLM_PROXY_TOKEN: string;
  AUTO_CREATE_TENANT: boolean;
};

export type TenantResult =
  | { ok: true; tenantId: string }
  | { ok: false; error: "missing_tenant" }
  | { ok: false; error: "unknown_tenant"; tenantName: string };

/** Whether the shared service token matches the configured value. */
export function serviceTokenMatches(headers: IncomingHttpHeaders, token: string): boolean {
  return headers[ROUTER_TOKEN_HEADER] === token;
}

/** Resolve the tenant named by the tenant header, auto-creating when configured. */
export async function resolveServiceTenant(
  headers: IncomingHttpHeaders,
  config: ServiceTokenConfig,
): Promise<TenantResult> {
  const tenantName = headers[TENANT_HEADER];
  if (typeof tenantName !== "string" || tenantName.length === 0) {
    return { ok: false, error: "missing_tenant" };
  }

  const tenant = config.AUTO_CREATE_TENANT
    ? await findOrCreateTenant(tenantName)
    : await findTenantByName(tenantName);
  if (!tenant) {
    return { ok: false, error: "unknown_tenant", tenantName };
  }

  return { ok: true, tenantId: tenant.id };
}
