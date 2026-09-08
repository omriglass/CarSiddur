// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { readLastUsedPolicyVersion, rememberLastUsedPolicyVersion } from "./lastUsedPolicy";

describe("last-used policy", () => {
  afterEach(() => localStorage.clear());

  it("remembers the policy version used for the next calculation on this device", () => {
    expect(readLastUsedPolicyVersion()).toBeNull();
    rememberLastUsedPolicyVersion("policy-version-2");
    expect(readLastUsedPolicyVersion()).toBe("policy-version-2");
  });
});
