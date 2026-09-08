/** Device-local default for the next solver run. It deliberately contains no
 * account or department data: a policy is only used when it is available in
 * the current department's policy options. */
const STORAGE_KEY = "carshare:last-used-policy-version";

export function readLastUsedPolicyVersion(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing and restrictive webviews may deny storage. The active
    // policy remains the safe fallback in that case.
    return null;
  }
}

export function rememberLastUsedPolicyVersion(policyVersionId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, policyVersionId);
  } catch {
    // Keeping a default is a convenience, never a reason to block solving.
  }
}
