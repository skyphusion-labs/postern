// The operator's sender domain (#615). ALLOWED_FROM_DOMAIN has no product default:
// postern is self-hosted, so any hardcoded fallback would make OUR domain every
// deployer's default. Unset (or blank) returns null, and each caller decides what
// "no domain configured" means at its seam (refuse, deny, or skip) rather than
// silently borrowing one.
export function allowedFromDomain(env: Env): string | null {
  const domain = (env.ALLOWED_FROM_DOMAIN || "").trim().toLowerCase();
  return domain || null;
}
