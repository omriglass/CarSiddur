import { describe, expect, it } from "vitest";

import { externalHintForCard, externalHintFromSuggestion } from "./externalHint";

describe("externalHint", () => {
  it("maps the solver's camelCase public transport to the payload value", () => {
    expect(externalHintFromSuggestion("publicTransport")).toBe("public_transport");
    expect(externalHintFromSuggestion("rental")).toBe("rental");
    expect(externalHintFromSuggestion("weird")).toBe("cab");
    expect(externalHintFromSuggestion(undefined)).toBe("cab");
  });
  it("opens the composer with the card's own suggestion", () => {
    expect(externalHintForCard([{ kind: "deny" }, { kind: "externalHint", hint: "publicTransport" }])).toBe("public_transport");
    expect(externalHintForCard([{ kind: "deny" }])).toBe("cab");
    expect(externalHintForCard(undefined)).toBe("cab");
  });
});
