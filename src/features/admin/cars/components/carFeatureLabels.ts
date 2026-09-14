import { he } from "@/i18n/he";

import { CAR_FEATURES } from "../schema";

export const FEATURE_LABEL: Record<(typeof CAR_FEATURES)[number], string> = {
  roof_rack: he.adminCars.featureRoofRack,
  large_trunk: he.adminCars.featureLargeTrunk,
  automatic: he.adminCars.featureAutomatic,
  awd: he.adminCars.featureAwd,
};
