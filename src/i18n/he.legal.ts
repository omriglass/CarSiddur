/**
 * Short public-page strings (owner 2026-10-12): the sign-in page doubles as the app's public home page for Google's
 * OAuth requirements, so it describes the product generically (shared vehicles, never a specific community) and links
 * to `/privacy` and `/terms`. The documents themselves live in `he.legalDocs.ts` (lazy). Merged into `he` by `he.ts`.
 */
export const heLegal = {
  legal: {
    contactEmail: "omri.glass1@gmail.com",
    /** The sign-in page doubles as the public home page: generic, never a specific community. */
    homeTitle: "סידור רכב",
    homeTagline: "תיאום רכבים משותפים, במקום אחד",
    homeDescription:
      "סידור רכב היא אפליקציה לניהול רכבים משותפים: חברי הקבוצה מגישים בקשות נסיעה, הרכזים בונים את סידור הרכב השבועי, וכולם רואים מי נוסע, מתי ובאיזה רכב. הכניסה עם חשבון Google, באישור מנהל הקבוצה.",
    homeDescriptionEn:
      "CarSiddur is an app for managing shared vehicles: members request rides, coordinators build the weekly schedule, and everyone sees who drives, when and in which car.",
    privacyLink: "מדיניות פרטיות",
    termsLink: "תנאי שימוש",
    backToApp: "חזרה לאפליקציה",
    languageLabel: "שפה",
    hebrew: "עברית",
    english: "English",
  },
};
