import { describe, expect, it } from "vitest";
import { chauffeurRideLabel } from "@/lib/rideLabel";
import { tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { resolveRideRealDestination, rideBlockLabel } from "./rideLabel";

const HOME = "home-dest";
const TLV = "tlv-dest";
const HAIFA = "haifa-dest";

describe("rideBlockLabel", () => {
  it("shows the fixed missing-driver relocation label regardless of served (REQ §89)", () => {
    const label = rideBlockLabel({
      originId: HAIFA, destinationId: HOME, originName: "חיפה", destinationName: "נבו",
      homeDestinationId: HOME, served: [], autoRelocation: true,
    });
    expect(label).toBe("החזרת רכב — חסר/ה נהג/ת");
  });

  it("keeps different passenger destinations visible on one combined booking", () => {
    const input = { originId: HOME, destinationId: HOME, originName: "home", destinationName: "home", homeDestinationId: HOME,
      served: [
        { role: "driver" as const, requester: "X", destination: "Pardes Hana" },
        { role: "passenger" as const, requester: "Y", destination: "Train", leg: "out" as const },
      ] };
    expect(rideBlockLabel(input)).toContain("X");
    expect(rideBlockLabel(input)).toContain("Y");
    expect(rideBlockLabel(input)).toContain("Pardes Hana");
    expect(rideBlockLabel(input)).toContain("Train");
    expect(resolveRideRealDestination(input)).toBe("Pardes Hana · Train");
  });
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

  it("REQUIREMENTS §13.93: a round trip from a non-home default origin shows מ<origin>", () => {
    const label = rideBlockLabel({
      originId: HAIFA,
      destinationId: HAIFA,
      originName: "חיפה",
      destinationName: "חיפה",
      homeDestinationId: HOME,
      served: [{ role: "driver", requester: "עומרי כהן", destination: "תל אביב", origin_id: HAIFA, origin_name: "חיפה" }],
    });
    expect(label).toBe("עומרי מחיפה לתל אביב");
  });

  it("REQUIREMENTS §13.93: a chauffeur drop-off leg uses the precise wording", () => {
    const label = rideBlockLabel({
      originId: HOME, destinationId: TLV, originName: "נבו", destinationName: "תל אביב", homeDestinationId: HOME,
      needsDriver: false, driverName: "דנה לוי",
      served: [{ role: "passenger", requester: "יואב", destination: "תל אביב", leg: "out", car_mode: "chauffeur" }],
    });
    expect(label).toBe("דנה מסיע/ה את יואב לתל אביב וחוזר/ת · מסלול: נבו → תל אביב");
  });

  it("REQUIREMENTS §13.93: a chauffeur pickup leg names the ride's own departure time", () => {
    const label = rideBlockLabel({
      originId: HOME, destinationId: TLV, originName: "נבו", destinationName: "תל אביב", homeDestinationId: HOME,
      needsDriver: false, driverName: "דנה לוי", startsAt: "2026-09-13T12:20:00.000Z",
      served: [{ role: "passenger", requester: "יואב", destination: "תל אביב", leg: "return", car_mode: "chauffeur" }],
    });
    expect(label).toContain("דנה אוסף/ת את יואב מתל אביב (הנסיעה מתחילה ב-");
  });

  it("R7B6: a pickup away from the car still shows the passenger's destination on the car path", () => {
    const label = rideBlockLabel({
      originId: HOME, destinationId: HOME, originName: "חדרה", destinationName: "חדרה", homeDestinationId: HOME,
      needsDriver: false, driverName: "נטע סופר", startsAt: "2026-09-13T04:00:00.000Z",
      served: [{ role: "passenger", requester: "מאיה", destination: "בנימינה", leg: "out", origin_id: "other", origin_name: "גבעת חביבה", car_mode: "chauffeur" }],
    });
    expect(label).toContain("מסלול: חדרה → גבעת חביבה → בנימינה → חדרה");
  });

  it("REQUIREMENTS §13.93: a relay pair's leave/wait legs name the place, not a direction prefix (no partner known yet)", () => {
    const leave = rideBlockLabel({
      originId: HOME, destinationId: HAIFA, originName: "נבו", destinationName: "חיפה", homeDestinationId: HOME,
      served: [{ role: "driver", requester: "רון", destination: "חיפה", leg: "out", car_mode: "relay", trip_type: "drop_off" }],
    });
    expect(leave).toBe("משאיר/ה את הרכב בחיפה");
    const wait = rideBlockLabel({
      originId: HAIFA, destinationId: HOME, originName: "חיפה", destinationName: "נבו", homeDestinationId: HOME,
      served: [{ role: "driver", requester: "Dana", destination: "נבו", leg: "return", car_mode: "relay", trip_type: "drop_off" }],
    });
    expect(wait).toBe("הרכב מחכה בחיפה · חזרה לנבו");
  });

  it("REQUIREMENTS §13.93: a relay pair's leave/wait legs name the partner and the time (v_board_rides.relay_partner)", () => {
    const leave = rideBlockLabel({
      originId: HOME, destinationId: HAIFA, originName: "נבו", destinationName: "חיפה", homeDestinationId: HOME,
      served: [{ role: "driver", requester: "רון", destination: "חיפה", leg: "out", car_mode: "relay", trip_type: "drop_off" }],
      relayPartner: { ride_id: "r2", name: "יוסי כהן", at: "2026-10-04T06:00:00.000Z" },
    });
    expect(leave).toBe(tv("rideCoordination.relayLeaveFor", { place: "חיפה", name: "יוסי", time: formatTime(new Date("2026-10-04T06:00:00.000Z")) }));
    const wait = rideBlockLabel({
      originId: HAIFA, destinationId: HOME, originName: "חיפה", destinationName: "נבו", homeDestinationId: HOME,
      served: [{ role: "driver", requester: "Dana", destination: "נבו", leg: "return", car_mode: "relay", trip_type: "drop_off" }],
      relayPartner: { ride_id: "r1", name: "דנה לוי", at: "2026-10-04T05:40:00.000Z" },
    });
    expect(wait).toBe(tv("rideCoordination.relayWaitFrom", { place: "חיפה", name: "דנה", time: formatTime(new Date("2026-10-04T05:40:00.000Z")) }));
  });

  it("REQUIREMENTS §13.93: a plain הלוך בלבד leg says the car stays there, no partner named", () => {
    const label = rideBlockLabel({
      originId: HOME, destinationId: HAIFA, originName: "נבו", destinationName: "חיפה", homeDestinationId: HOME,
      served: [{ role: "driver", requester: "רון", destination: "חיפה", leg: "out", car_mode: "relay", trip_type: "one_way" }],
    });
    expect(label).toBe("רון לחיפה (הרכב נשאר שם)");
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

describe("chauffeurRideLabel — drop-off vs pickup (REQ §13.93)", () => {
  const harish = { requester: "Dana Cohen", destination: "Givat Haviva", origin_id: "harish", origin_name: "Harish", leg: "out" as const, car_mode: "chauffeur" as const, role: "passenger" as const };

  it("an out leg whose origin is where the car is reads as a drop-off", () => {
    expect(chauffeurRideLabel("Avi Levi", [{ ...harish, origin_id: "home", origin_name: "Givat Haviva", destination: "Harish" }], undefined, "home"))
      .toBe(tv("rideCoordination.chauffeurDropoff", { driver: "Avi", name: "Dana", place: "Harish" }));
  });

  it("an out leg starting away from the car ('pick me up from Harish') reads as a pickup at its origin", () => {
    expect(chauffeurRideLabel(null, [harish], undefined, "home"))
      .toBe(tv("rideCoordination.chauffeurPickupNeedsDriver", { name: "Dana", place: "Harish", time: "" }));
  });
});

describe("R5U2: a pickup / chauffeur ride shows the car's real path", () => {
  it("pickup: home → pickup place → home, and the start time is not called a departure", () => {
    const label = rideBlockLabel({
      originId: HOME, destinationId: HOME, originName: "נבו", destinationName: "נבו", homeDestinationId: HOME,
      needsDriver: false, driverName: "דנה לוי", startsAt: "2026-09-13T12:20:00.000Z",
      served: [{ role: "passenger", requester: "יואב", destination: "תל אביב", leg: "return", car_mode: "chauffeur" }],
    });
    expect(label).toContain("מסלול: נבו → תל אביב → נבו");
    expect(label).not.toContain("יציאה");
  });
});
