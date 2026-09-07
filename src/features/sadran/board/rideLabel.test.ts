import { describe, expect, it } from "vitest";

import { resolveRideRealDestination, rideBlockLabel } from "./rideLabel";

const HOME = "home-dest";
const TLV = "tlv-dest";
const HAIFA = "haifa-dest";

describe("rideBlockLabel", () => {
  it("driver only, round trip", () => {
    const label = rideBlockLabel({
      originId: HOME,
      destinationId: HOME,
      originName: "נבו",
      destinationName: "נבו",
      homeDestinationId: HOME,
      served: [{ role: "driver", requester: "עומרי כהן", destination: "תל אביב" }],
    });
    expect(label).toBe("עומרי לתל אביב");
  });

  it("driver + 2 passengers, round trip", () => {
    const label = rideBlockLabel({
      originId: HOME,
      destinationId: HOME,
      originName: "נבו",
      destinationName: "נבו",
      homeDestinationId: HOME,
      served: [
        { role: "driver", requester: "עומרי כהן", destination: "תל אביב" },
        { role: "passenger", requester: "עומר לוי", destination: "תל אביב" },
        { role: "passenger", requester: "דנה ברק", destination: "תל אביב" },
      ],
    });
    expect(label).toBe("עומרי, עומר ודנה לתל אביב");
  });

  it("one-way-from: labels with מ<origin>, not the home destination", () => {
    const label = rideBlockLabel({
      originId: HAIFA,
      destinationId: HOME,
      originName: "חיפה",
      destinationName: "נבו",
      homeDestinationId: HOME,
      served: [{ role: "driver", requester: "יואב לוי", destination: "חיפה" }],
    });
    expect(label).toBe("יואב מחיפה");
  });

  it("one-way-to: labels with ל<destination>", () => {
    const label = rideBlockLabel({
      originId: HOME,
      destinationId: TLV,
      originName: "נבו",
      destinationName: "תל אביב",
      homeDestinationId: HOME,
      served: [{ role: "driver", requester: "מיכל אבני", destination: "תל אביב" }],
    });
    expect(label).toBe("מיכל לתל אביב");
  });

  it("free-text destination (no destinations row): served.destination carries the raw text", () => {
    const label = rideBlockLabel({
      originId: HOME,
      destinationId: HOME,
      originName: "נבו",
      destinationName: "נבו",
      homeDestinationId: HOME,
      served: [{ role: "driver", requester: "רון ברק", destination: "חתונה בקיבוץ שכן" }],
    });
    expect(label).toBe("רון לחתונה בקיבוץ שכן");
  });

  it("falls back to the ride's own destination name when no served request has one", () => {
    const label = rideBlockLabel({
      originId: HOME,
      destinationId: HOME,
      originName: "נבו",
      destinationName: "נבו",
      homeDestinationId: HOME,
      served: [],
    });
    expect(label).toBe("לנבו");
  });
});

describe("resolveRideRealDestination", () => {
  it("returns the real destination for a round trip (BoardListMode's RideCard fields), not home", () => {
    expect(
      resolveRideRealDestination({
        originId: HOME,
        destinationId: HOME,
        originName: "נבו",
        destinationName: "נבו",
        homeDestinationId: HOME,
        served: [{ role: "driver", requester: "עומרי כהן", destination: "תל אביב" }],
      }),
    ).toBe("תל אביב");
  });

  it("returns the origin for a one-way-from leg", () => {
    expect(
      resolveRideRealDestination({
        originId: HAIFA,
        destinationId: HOME,
        originName: "חיפה",
        destinationName: "נבו",
        homeDestinationId: HOME,
        served: [{ role: "driver", requester: "יואב לוי", destination: "חיפה" }],
      }),
    ).toBe("חיפה");
  });
});
