/**
 * Canonical Hebrew UI dictionary (CLAUDE.md hard rule 3: UI strings live only
 * here, via `t()`). Seeded from `docs/UX_FLOWS.md` §10. Solver reason
 * strings live in `src/solver/reasons.ts`; templated notification/WhatsApp
 * copy and catalog names are seeded DB data — neither belongs here.
 *
 * A few glossary entries in §10 name both a screen/field itself and a child
 * of that same path (e.g. `field.destination` and `field.destination.freeText`).
 * A plain object can't hold both a string leaf and children at the same key,
 * so those are flattened here (`field.destinationFreeText`, `field.oneWayTo`,
 * `field.oneWayFrom`) — the Hebrew copy is unchanged, only the key shape.
 */
import { heAdmin } from "./he.admin";
import { heMember } from "./he.member";
import { heSadran } from "./he.sadran";

import type { NotificationEvent } from "@/lib/enums";

// `requests.status_reason` is a free-text column (no SQL enum), so there is
// no generated type to mirror. This TS-only list is grepped from every
// UPPER_SNAKE literal assigned to `status_reason` across `supabase/migrations/
// *.sql`; `statusReason` below is typed `satisfies Record<StatusReasonCode,
// string>` so a code missing its Hebrew label fails `npm run typecheck`.
// Renderers must fall back to `he.statusReasonUnknown` (never the raw code)
// for any value not in this list (e.g. a future DB-only code not yet mirrored
// here).
export const STATUS_REASON_CODES = [
  "ASK_TO_JOIN_TEMP_CAR",
  "AUTO_APPROVED",
  "AUTO_APPROVED_FREE_CAR",
  "CANCELLED_BY_MEMBER",
  "DENIED_BY_SADRAN",
  "DRIVER_CLAIMED",
  "DUPLICATE_OVERLAP",
  "DUPLICATE_WITHDRAWN",
  "EXTERNAL",
  "FREED_SLOT_APPROVED",
  "FREED_SLOT_AUTO",
  "NO_HOME_LOCATION",
  "PROPOSAL_APPLIED",
  "PROPOSAL_APPLIED_PENDING_ASSIGNMENT",
  "RIDE_CANCELLED",
  "SADRAN_ASSIGNED",
  "SADRAN_EDIT",
  "SADRAN_MANUAL",
  "SADRAN_UNASSIGNED",
  "SERIES_CAR_UNAVAILABLE",
  "SERIES_PLACED",
  "SERIES_SHORTENED",
  "UNMET_NEEDS_DRIVER",
  "UNSAFE_ISSUE",
  "WAITLISTED_CONTESTED",
  "WAITLISTED_NOT_CHOSEN",
  "WAITLISTED_NO_CAR",
  "WAITLISTED_ONE_WAY",
  "WAITLISTED_PUBLISHED_DAY",
  "WAITLISTED_SERIES_NO_CAR",
  "WAITLIST_RESOLVED",
  "WAITLIST_RESOLVED_DRIVER",
  "WAITLIST_RESOLVED_PASSENGER",
  "WITHDRAWN_BY_MEMBER",
] as const;
export type StatusReasonCode = (typeof STATUS_REASON_CODES)[number];

export const he = {
  timeField: { hourListLabel: "שעה", minuteListLabel: "דקות" },
  departmentContext: { copyFrom: "העתקת רשימות ממחלקה", blankDepartment: "מחלקה ריקה", copyHelp: "יועתקו יעדים, סוגי נסיעות ומדיניות. הרשימות יהיו עצמאיות; לאחר היצירה ניתן לשנות את נקודת המוצא.", label: "מחלקה", viewOnly: "צפייה בלבד", noMembership: "כדי להגיש בקשה למחלקה זו יש להצטרף אליה דרך מנהל/ת המערכת." },
  tableView: {
    cards: "כרטיסיות", table: "טבלה", label: "תצוגת הסידור",
    zoomIn: "הגדלת הטבלה", zoomOut: "הקטנת הטבלה", resetZoom: "איפוס גודל הטבלה",
    landscape: "תצוגה לרוחב", exitLandscape: "יציאה מתצוגה לרוחב",
    rotateHint: "לתצוגה לרוחב, סובבו את הטלפון. אם המסך לא מסתובב, בטלו את נעילת הסיבוב במכשיר.",
  },
  publicationFlow: {
    closeAndPublish: "סגירת בקשות ופרסום",
    cancel: "ביטול הפרסום",
    cancelTitle: "ביטול פרסום או פתיחת בקשות",
    reopen: "פתיחה מחדש לבקשות",
    unpublish: "ביטול פרסום בלבד",
    reopenHelp: "הסידור יוסתר מהחברים וחלון הבקשות ייפתח מחדש. השיבוצים יישמרו לעריכה בלוח.",
    unpublishHelp: "הסידור יוסתר מהחברים ויישאר לעריכה בלוח. חלון הבקשות יישאר סגור.",
    confirmCancel: "אישור הביטול",
    cancelled: "הפרסום בוטל והשיבוצים נשמרו",
    allQuestion: "לפרסם את כל הסידור?",
    allYes: "כן, פרסום הכול",
    onlyReady: "רק ימים מוכנים",
    selectDays: "בחירת ימים לפרסום",
    selectedPublish: "פרסום הימים שנבחרו",
    readiness: "{{count}} מתוך 7 ימים מוכנים לפרסום",
    allReady: "כל הבקשות קיבלו מענה. אפשר לפרסם את כל הסידור.",
    ready: "מוכן לפרסום",
    published: "כבר פורסם",
    unresolved: "{{count}} בקשות ללא מענה",
    pending: "{{count}} הצעות ללא תשובה",
    pendingOne: "הצעה אחת ללא תשובה",
    unresolvedOne: "בקשה אחת ללא מענה",
    missingDriverOne: "נסיעה אחת ללא נהג/ת",
    answeredElsewhere: "{{count}} בקשות נענו בדחייה או בפתרון חיצוני",
    answeredElsewhereOne: "בקשה אחת נענתה בדחייה או בפתרון חיצוני",
    pendingTitle: "הצעות שעוד ממתינות לתשובה (הפרסום לא יבטל אותן):",
    pendingRow: "{{name}} · {{type}} · {{day}} · עד {{expires}}",
    missingDriver: "{{count}} נסיעות ללא נהג/ת",
    placedCount: "שובצו {{placed}} מתוך {{total}} בקשות",
    expiringTitle: "הצעות דחייה/פתרון חיצוני שעוד לא נענו יפוגו עם הפרסום:",
    expiringWhoIsTold: "ההצעה תפוג והסדרן/ית ששלח/ה אותה יקבל/ת הודעה. החברים ברשימה לא יקבלו הודעת פקיעה נפרדת, כדאי לעדכן אותם.",
    expiringRow: "{{name}} · {{type}} · {{day}}",
    conflicts: "{{count}} התנגשויות — יש לפתור לפני פרסום",
    noSelection: "יש לבחור לפחות יום אחד",
    unresolvedTitle: "לפרסם למרות הבקשות שטרם קיבלו מענה?",
    unresolvedHelp: "בימים שנבחרו יש בקשות ללא מענה, הצעות שממתינות לתשובה או נסיעות ללא נהג/ת. השיבוצים יפורסמו והבקשות הפתוחות יישארו לטיפול.",
    confirmUnresolved: "כן, לפרסם בכל זאת",
    backToBoard: "חזרה ללוח",
    partialHint: "רק הימים שנבחרו יפורסמו. אפשר להוסיף ימים בהמשך.",
    dayUnpublished: "הסידור ליום הזה עדיין לא פורסם",
  },
  siddurCar: {
    replacementName: "{{name}} (חלופי)",
    withCode: "{{name}} · {{code}}",
    withoutCode: "{{name}} · קוד לא הוזן",
  },
  /**
   * Swap cars on a day by dragging car names (REQ §13.92, owner batch
   * 2026-09-24 S1). Shared by the Sadran board and the member siddur grid —
   * `CarSwapDialog` (`src/components/`) and the `WeekGrid` car-header
   * drag/menu affordance both read from here.
   */
  carSwap: {
    swapMenuLabel: "החלף רכב",
    swapWithCar: "החלפה עם {{car}}",
    dialogTitle: "החלפת {{carA}} ו{{carB}}",
    dialogDay: "ביום {{day}}",
    movedCount: "יועברו {{count}} נסיעות",
    noRidesToMove: "אין נסיעות להעברה",
    fromCarHeading: "מ{{car}}",
    unknownRide: "הנסיעה",
    blockersTitle: "לא ניתן להחליף",
    blockerSeats: "הנסיעה {{ride}} לא נכנסת לרכב {{car}} (מקומות/מטען)",
    blockerLuggage: "הנסיעה {{ride}} כוללת ציוד גדול, ולרכב {{car}} אין תא מטען גדול",
    blockerMaintenance: "לרכב {{car}} מתוכנן טיפול בזמן הנסיעה {{ride}}",
    blockerPrivateCar: "רכב פרטי — רק הבעלים יכול/ה להחליף",
    blockerPast: "הנסיעה {{ride}} כבר עברה",
    blockerNotAllowedRide: "לא ניתן להחליף את הנסיעה {{ride}}",
    blockerNotAllowedGeneric: "לא ניתן להחליף את הרכבים האלה ביום זה",
    seriesQuestion: "הנסיעה היא חלק מבקשה רב-יומית",
    seriesWhole: "כל ימי הנסיעה ({{range}})",
    seriesDayOnly: "רק היום (הנסיעה תפוצל)",
    noticeEndsAway: "שים/י לב: {{car}} מסיים/ת את היום ב{{place}}",
    successToast: "הרכבים הוחלפו",
    notifiedToast: "נשלחו {{count}} הודעות",
  },
  ...heMember,
  ...heAdmin,
  ...heSadran,
  ridePublicDetails: {
    passengers: "נוסעים: {{summary}}",
    unnamedAdult: "מבוגר/ת 1",
    unnamedAdults: "{{count}} מבוגרים/ות",
    unnamedChild: "ילד/ה 1",
    unnamedChildren: "{{count}} ילדים/ות",
    joinPassengers: "{{names}} ו{{last}}",
    label: "מידע נוסף לכולם",
    help: "המידע יוצג לכל מי שצופה בנסיעה. אפשר לעדכן אותו כבעלי הנסיעה או כסדרן/ית.",
    saved: "המידע לנסיעה עודכן",
    save: "שמירת המידע לכולם",
    companions: "נוסעים נוספים: {{names}}",
    invalidDescription: "אפשר להוסיף עד 1,000 תווים לתיאור הנסיעה",
    invalidGuestNames: "יש להזין שם בכל שורה, עד 100 תווים לשם ועד 20 שמות",
    invalidCompanions: "יש לבחור נוסעים מאושרים מהמחלקה, בלי לבחור את עצמך או את אותו אדם פעמיים",
    namesExceedSeats: "מספר הנוסעים צריך לכלול אותך ואת כל הנוסעים ששמם נוסף",
    invalidQuickReservation: "אפשר להוסיף נסיעה שממתינה לנהג/ת רק לסידור הפעיל של המחלקה שלך",
  },
  /** One-line route for notifications/WhatsApp copy (REQ §13.93) — mirrors the seeded `text_fragments` `route.*` rows used by SQL `route_label()`. */
  route: {
    to: "ל{{destination}}",
    fromTo: "מ{{origin}} ל{{destination}}",
    via: "מ{{origin}} דרך {{stops}} ל{{destination}}",
    toVia: "דרך {{stops}} ל{{destination}}",
    /** Ride card line (board + siddur): the stops by name instead of a count (owner 2026-10-05). */
    viaStops: "דרך: {{stops}}",
    viaStopsReturn: "חזרה דרך: {{stops}}",
  },
  rideCoordination: {
    cancelHelp: "הבקשה שלך תבוטל. אם נהגת עבור נוסעים נוספים, הנסיעה שלהם תישאר בסידור ותסומן כחסרת נהג/ת עד שמישהו יתנדב. ביטול של נוסע/ת אינו מבטל את נסיעת האחרים.",
    passengerTo: "{{name}} ל{{destination}}",
    passengerFrom: "{{name}} מ{{destination}}",
    /** R5U2: the car's real path on a pickup/chauffeur ride ("נבו → חדרה → נבו"). */
    carPath: "מסלול: {{path}}",
    chauffeurLabel: "{{driver}} מסיע את {{passengers}}",
    /** Needs-driver wordings (R2B23): no driver yet, so never a "_____" placeholder. */
    chauffeurLabelNeedsDriver: "נדרש/ת נהג/ת להסיע את {{passengers}}",
    chauffeurDropoffNeedsDriver: "נדרש/ת נהג/ת להסיע את {{name}} ל{{place}} ולחזור",
    chauffeurPickupNeedsDriver: "נדרש/ת נהג/ת לאסוף את {{name}} מ{{place}} (הנסיעה מתחילה ב-{{time}})",
    /** REQUIREMENTS §13.93 "Display": a chauffeur ride's single drop-off leg. */
    chauffeurDropoff: "{{driver}} מסיע/ה את {{name}} ל{{place}} וחוזר/ת",
    /** REQUIREMENTS §13.93 "Display": a chauffeur ride's single pickup leg — `{{time}}` is when the car starts out, not the pickup time. */
    chauffeurPickup: "{{driver}} אוסף/ת את {{name}} מ{{place}} (הנסיעה מתחילה ב-{{time}})",
    /** REQUIREMENTS §13.93 "Display": a הקפצה relay pair's out-leg — the car is left for a later trip to take on. Fallback when the partner ride isn't known yet. */
    relayLeave: "משאיר/ה את הרכב ב{{place}}",
    /** REQUIREMENTS §13.93 "Display": same out-leg, naming the partner who picks the car up and when (`v_board_rides.relay_partner`). */
    relayLeaveFor: "משאיר/ה את הרכב ב{{place}} ל{{name}} ({{time}})",
    /** REQUIREMENTS §13.93 "Display": a הקפצה relay pair's return/pickup leg — the car is picked up from where it was left. Fallback when the partner ride isn't known yet. */
    relayWait: "הרכב מחכה ב{{place}}",
    /** R2U5: the same card names its route when no partner is known. */
    relayWaitRoute: "הרכב מחכה ב{{place}} · חזרה ל{{destination}}",
    /** REQUIREMENTS §13.93 "Display": same return leg, naming the partner who left the car there and when they bring it (`v_board_rides.relay_partner`). */
    relayWaitFrom: "הרכב מחכה לך ב{{place}} — {{name}} מביא/ה אותו ב-{{time}}",
    /** REQUIREMENTS §13.93 "Display": a plain הלוך בלבד leg — the car stays at the destination with nobody designated to bring it back. */
    oneWayParked: "{{name}} ל{{place}} (הרכב נשאר שם)",
    missingDriver: "חסר/ה נהג/ת",
    volunteer: "אני אנהג בנסיעה הזו",
    volunteerHelp: "ההתנדבות כוללת את הסעת הנוסעים והחזרת הרכב, לפי השעות המוצגות.",
    volunteered: "שובצת כנהג/ת הנסיעה",
    noLongerMissing: "הנסיעה כבר שובצה לנהג/ת או השתנתה. יש לרענן את הסידור.",
    driverBusy: "כבר שובצת לנהיגה בנסיעה אחרת בשעות האלה.",
    past: "לא ניתן לשנות נסיעה שכבר הסתיימה.",
    invalidPreferredCar: "יש לבחור רכב שיתופי פעיל מהמחלקה שלך, או להסיר את העדפת הרכב.",
    awaitingConsent: "נדרש אישור מכל המשתתפים לפני החלת השינוי.",
    tightSchedule: "לוח זמנים צפוף",
    combinedWindow: "שעות הנסיעה המשולבת",
    combinedConsent: "השינוי יוחל רק אחרי אישור הנהג/ת וכל הנוסעים המושפעים ממנו.",
    combinedSummary: "נסיעה משולבת: {{driver}} מסיע/ה את {{passenger}} ל{{destination}}, ברכב {{car}}, בשעות {{start}}–{{end}}.",
    combinedSummaryReturn: "נסיעה משולבת: {{driver}} אוסף/ת את {{passenger}} מ{{destination}}, ברכב {{car}}, בשעות {{start}}–{{end}}.",
    driverWanted: "נהג/ת שעוד לא נמצא/ה",
    /** R4U7: a merge into a ride still needing a driver names no driver. */
    combinedSummaryNoDriver: "נסיעה משולבת: הנסיעה עוד מחפשת נהג/ת. {{passenger}} מצטרף/ת לנסיעה ל{{destination}}, ברכב {{car}}, בשעות {{start}}–{{end}}.",
    combinedSummaryReturnNoDriver: "נסיעה משולבת: הנסיעה עוד מחפשת נהג/ת. {{passenger}} נאסף/ת מ{{destination}}, ברכב {{car}}, בשעות {{start}}–{{end}}.",
    separateDestinations: "יעדים לפי בקשה",
    /** REQ §13.93/SOLVER §3.15: the `origin` proposal's one-line summary (composer + `/p/:token`). */
    originChangeSummary: "יציאה מ{{to}} במקום מ{{from}}, ברכב {{car}}",
  },
  deviations: {
    title: "כל השינויים מהבקשות המקוריות",
    help: "השוואה בין הבקשות המקוריות לבין השיבוץ הנוכחי לכל השבוע. שינויים שאושרו עדיין מופיעים כאן.",
    empty: "אין שינויים מהבקשות המקוריות",
    original: "בבקשה המקורית",
    current: "בשיבוץ הנוכחי",
    depart: "יציאה",
    arrival: "חזרה / הגעה",
    preferredCar: "הרכב המועדף",
    passenger: "שיבוץ כנוסע/ת",
    unassigned: "טרם שובץ",
    reason: "מצב הבקשה",
    loadError: "לא ניתן לטעון את השינויים כרגע",
    noName: "חבר/ה",
  },
  rideEditing: {
    edit: "שינוי הרכב והשעות",
    saved: "הנסיעה עודכנה",
    collisionTitle: "כבר קיימת נסיעה בזמן הזה",
    collisionBody: "אפשר לבקש מהנהגים/ות לפנות את הזמן. הנסיעה הקיימת תישאר בתוקף עד שכולם יאשרו את הביטול. השינוי שלך יופיע בהמתנה לאישור.",
    acknowledge: "אני מודע/ת — שליחת בקשה",
    requested: "הבקשה נשלחה לנהגים/ות לאישור",
    pending: "ממתין לאישור פינוי הזמן",
    cancelRequest: "ביטול הבקשה לפינוי זמן",
    answerTitle: "בקשה לפינוי זמן הנסיעה",
    answerBody: "{{name}} מבקש/ת לבטל את נסיעתך כדי להעביר נסיעה לזמן {{time}}. אישור מבטל את הנסיעה רק לאחר שכל הנהגים/ות אישרו והזמן נבדק מחדש.",
    accept: "אישור ביטול הנסיעה שלי",
    decline: "שמירת הנסיעה שלי",
    answered: "התשובה נשמרה",
    unavailable: "הרכב אינו זמין בזמן הזה או שאין מספיק מקומות",
    wrongDay: "אפשר להזיז נסיעה רק בתוך היום המקורי",
    invalidTime: "יש לבחור שעת סיום מאוחרת משעת ההתחלה",
    needsCoordinator: "הנסיעה כוללת נוסעים נוספים או החלפת רכב. יש לפנות לסדרן/ית לתיאום השינוי.",
    noConflict: "הזמן כבר התפנה. סגרו את ההודעה ונסו לשמור שוב.",
    noLongerPending: "הבקשה הזו כבר טופלה. רעננו את הסידור.",
    archived: "השבוע הועבר לארכיון ולא ניתן לשנות אותו.",
    alreadyPending: "כבר יש שינוי שממתין לטיפול בנסיעה הזו. יש לטפל בו לפני שינוי נוסף.",
    pendingPublish: "יש בקשות לפינוי זמן שעדיין ממתינות לתשובה. יש לטפל בהן לפני הפרסום.",
  },
  whatsappDialog: {
    close: "סגירת ההודעה",
    title: "שליחת הודעה בוואטסאפ",
    recipient: "הודעה אל {{name}}",
    copy: "העתקת ההודעה",
    copied: "ההודעה הועתקה",
    handoff: "פתיחה בוואטסאפ",
    help: "אפשר לערוך או להעתיק כאן את ההודעה. לאחר הפתיחה בוואטסאפ ניתן לחזור למסך הזה עם כפתור החזרה.",
  },
  publishScores: {
    invalid: "לא ניתן לחשב את הציונים. בדקו שקיימת מדיניות תקינה ולכל הבקשות יש שעות ופרטים מלאים.",
    title: "השוואת הסידור לפרופילי המדיניות",
    help: "בכל פרסום נבדק השיבוץ הסופי מול כל פרופילי המדיניות. נשמר הניקוד של הבקשות ששובצו מתוך כלל הניקוד שהתבקש, כולל השינויים הידניים.",
    policy: "פרופיל מדיניות",
    coverage: "שיעור הניקוד ששובץ",
    noPriority: "ללא ניקוד",
    profile: "חבר/ה",
    served: "בקשות ששובצו",
    priority: "ניקוד ששובץ / ניקוד כולל",
    calculating: "חישוב ציונים ופרסום…",
  },
  app: {
    name: "סידור רכב — נבו",
    tagline: "תיאום הרכבים המשותפים של הקיבוץ, במקום אחד",
  },
  nav: {
    siddur: "הסידור",
    myRequests: "הבקשות שלי",
    inbox: "הודעות",
    profile: "פרופיל",
    sadran: "סדרן",
    admin: "ניהול מערכת",
  },
  screen: {
    signin: { title: "התחברות" },
    pending: { title: "ממתין לאישור" },
    onboarding: { title: "ברוכים הבאים" },
    home: { title: "השבוע שלי" },
    request: {
      new: "בקשה חדשה",
      edit: "עריכת בקשה",
      detail: "פרטי הבקשה",
    },
    siddur: { title: "הסידור" },
    ride: { detail: "פרטי הנסיעה" },
    proposal: {
      title: "הצעה מהסדרן/ית",
      compose: "הצעה חדשה",
    },
    inbox: { title: "הודעות" },
    profile: { title: "פרופיל" },
    sadran: {
      home: "סדרן",
      dashboard: "סידור השבוע",
    },
    board: { title: "לוח הסידור" },
    proposals: { title: "הצעות" },
    claims: { title: "רכב שהתפנה" },
    publish: { title: "פרסום הסידור" },
    log: { title: "יומן שינויים" },
    admin: {
      home: "ניהול מערכת",
      departments: "מחלקות",
      members: "חברים",
      roster: "סבב סדרנים",
      cars: "רכבים",
      maintenance: "חסימות לטיפול",
      destinations: "יעדים",
      rideTypes: "סוגי נסיעה",
      policies: "מדיניות עדיפויות",
      templates: "תבניות הודעות",
      settings: "הגדרות",
      issues: "תקלות ברכבים",
    },
  },
  action: {
    signinGoogle: "התחברות עם Google",
    signInEmail: "התחברות",
    useDifferentAccount: "התחברות עם חשבון אחר",
    installedAlready: "כבר הוספתי",
    checkAgain: "בדוק שוב",
    firstRequest: "לבקשה הראשונה",
    enablePush: "אפשר התראות",
    newRequest: "בקשה חדשה",
    submitRequest: "הגש/י בקשה",
    submitWaitlist: "היכנס/י לרשימת המתנה",
    enterWaitingList: "הצטרפות לרשימת המתנה",
    saveRequest: "שמור/י שינויים",
    withdrawRequest: "הסר בקשה",
    cancelRide: "בטל נסיעה",
    askToJoin: "בקש/י להצטרף",
    reportIssue: "דווח/י על תקלה ברכב",
    acceptProposal: "מקבל/ת את ההצעה",
    declineProposal: "לא מתאים לי",
    understood: "הבנתי",
    foundExternal: "מצאתי פתרון אחר",
    markAllRead: "סמן הכול כנקרא",
    stillWant: "אני עדיין רוצה",
    registerTempCar: "רשום רכב",
    addOwnRide: "הוסף נסיעה",
    signOut: "התנתקות",
    closeWindow: "סגור חלון עכשיו",
    openBoard: "פתח לוח",
    publish: "פרסם…",
    undo: "בטל",
    autoSolveRemaining: "השלם אוטומטית",
    apply: "החל",
    propose: "הצע",
    markExternal: "סמן כפתרון חיצוני",
    deny: "דחה",
    pin: "נעל",
    unpin: "בטל נעילה",
    boost: "העדפה ידנית",
    splitLegs: "פצל הלוך/חזור",
    openWhatsApp: "פתח בוואטסאפ",
    recordAnswer: "רשום תשובה ידנית",
    approveClaim: "אשר",
    leaveFree: "אף אחד — השאר פנוי",
    publishAndNotify: "פרסם ושלח הודעות",
    copyGroupSummary: "העתק סיכום לוואטסאפ של הקבוצה",
    import: "ייבא",
    approve: "אשר",
    reject: "דחה",
    loadPreset: "טען מתבנית",
    addConfig: "הוסף תצורה",
    addBlock: "חסימה חדשה",
    mergeInto: "מזג לתוך…",
    createDestination: "צור יעד חדש",
    testLastWeek: "בדיקה על השבוע שעבר",
    saveAsVersion: "שמור כגרסה {{n}}",
    activateForDept: "הפוך לפעילה במחלקה…",
    restoreDefault: "שחזר ברירת מחדל",
    moveToMaintenance: "העבר לטיפול",
  },
  field: {
    email: "אימייל",
    password: "סיסמה",
    phone: "טלפון",
    fullName: "שם",
    destination: "לאן?",
    destinationFrom: "מאיפה?",
    destinationFreeText: "יעד חופשי",
    /** Origin field label (REQ §13.93) — opened when the member taps the "מ..." line above the destination. */
    origin: "נקודת יציאה",
    rideType: "סוג נסיעה",
    day: "יום",
    depart: "יציאה",
    return: "חזרה",
    roundTrip: "הלוך ושוב",
    oneWay: "כיוון אחד",
    oneWayTo: "לשם",
    oneWayFrom: "חזרה",
    carAtDestination: "הרכב נשאר איתי ביעד",
    adults: "מבוגרים (כולל נהג/ת)",
    childSeats: "ילדים במושב בטיחות",
    boosters: "ילדים בבוסטר",
    companions: "חברים שנוסעים איתך",
    children: "ילדים שנוסעים איתך",
    luggage: "מטען גדול",
    flexDepart: "גמישות ביציאה",
    flexReturn: "גמישות בחזרה",
    notes: "הערות לסדרן/ית",
    repeatWeekly: "חוזר כל שבוע",
  },
  flex: {
    earlier: "מוקדם יותר",
    later: "מאוחר יותר",
    "0": "0",
    "15": "¼ שעה",
    "30": "½ שעה",
    "60": "שעה",
    "120": "שעתיים",
    anyTime: "כל היום",
  },
  home: {
    rideTo: "נסיעה ל{{destination}}",
    rideFrom: "נסיעה מ{{destination}}",
    joiningTo: "מצטרף/ת {{name}} ל{{destination}}",
    joiningFrom: "מצטרף/ת {{name}} מ{{destination}}",
    greeting: "שלום, {{name}}",
    nextAction: "מחכה לתשובה שלך",
    myRides: "הנסיעות שלי",
    unplaced: "בקשות שעדיין לא שובצו",
    upcomingRides: "הנסיעות הקרובות שלי",
    unservedRequests: "בקשות שלא שובצו",
    emptyUpcoming: "אין לך נסיעות קרובות.",
    emptyUnserved: "כל הבקשות שלך שובצו 🎉",
    emptyRequestsOpen: "עוד אין לך בקשות לשבוע {{weekLabel}}.",
    emptyRequestsPublished:
      "לא הגשת בקשות לשבוע הזה. אפשר להגיש בקשה חדשה — אם יש רכב פנוי היא תאושר מיד.",
    weekRequests: "כל הבקשות שלי לשבוע זה",
  },
  auth: {
    devSectionTitle: "כניסת פיתוח (dev בלבד)",
    devHint:
      "משתמשי דמו: admin@nevo.local · sadran@nevo.local · member1@nevo.local · member2@nevo.local — סיסמה לכולם: nevo-demo-1234",
  },
  pending: {
    body: "הבקשה שלך לגישה נשלחה למנהל/ת. ברגע שתאושר תוכל/י להיכנס — בדקו שוב מאוחר יותר או פנו לסדרן/ית.",
    signedInAs: "נכנסת עם:",
  },
  onboarding: {
    stepDetails: "פרטים",
    stepNotifications: "התראות",
    stepDone: "סיום",
    phoneHint: "המספר משמש את הסדרן/ית לשליחת הצעות בוואטסאפ",
    phoneInvalid: "מספר טלפון לא תקין",
    pushDeniedHint: "אפשר להפעיל אחר כך בפרופיל",
    doneBody: "הכול מוכן. השבוע הבא פתוח לבקשות עד יום רביעי 12:00.",
  },
  deviceSetup: {
    installTitle: "סידור הרכב במסך הבית",
    installBody: "גישה מהירה לאפליקציה ישירות ממסך הבית.",
    install: "הוספה למסך הבית",
    pushTitle: "להישאר מעודכנים",
    pushBody: "קבלו התראה על שיבוצים, הצעות ושינויים בסידור גם כשהאפליקציה סגורה.",
    pushDenied: "ההתראות חסומות בדפדפן. אפשר לאפשר אותן בהגדרות האתר בדפדפן ולחזור לכאן.",
    later: "אחר כך",
  },
  installHint: {
    ios: 'באייפון, התראות עובדות רק אחרי הוספה למסך הבית: לחצו על שיתוף ← "הוסף למסך הבית", ואז פתחו את האפליקציה משם.',
    android: 'באנדרואיד: פתחו את תפריט הדפדפן ובחרו "הוספה למסך הבית".',
    desktop: "אפשר להתקין את האפליקציה מתפריט הדפדפן (סמל ההתקנה בשורת הכתובת).",
  },
  errorState: {
    title: "משהו השתבש. הנתונים שלך שמורים.",
    refresh: "רענן",
  },
  weekStrip: {
    today: "היום",
  },
  proposal: {
    type: {
      shift: "הזזת שעות",
      merge: "איחוד נסיעות",
      deny: "דחייה",
      external: "פתרון חיצוני",
      /** REQ §13.93/SOLVER §3.15: the `changeOrigin` suggestion -- "car free at a different place". */
      origin: "יציאה ממקום אחר",
    },
    optOutFreed: "אל תציעו לי מקומות שמתפנים השבוע",
    recorded: {
      accepted: "אישר/ה",
      declined: "דחה/תה",
    },
    /** `OpenProposalButton` — Home's next-action card and "my requests"' proposed-status row. */
    open: "פתח/י את ההצעה",
    /** Shown when the member's `proposal_received` notification can no longer be found; the button then routes to the inbox instead of `/p/:token`. */
    openFallback: "ההצעה נמצאת בתיבת ההודעות",
  },
  board: {
    unmet: "לא שובצו",
    conflicts: "התנגשות",
    policy: "מדיניות",
    policyChanged: "המדיניות שונתה — הרץ שוב",
    pendingConsent: "ממתין להסכמה",
    willUpdateOnPublish: "יעודכן בפרסום",
    /** Vertical-board redesign (UX_FLOWS.md §20): shared by the Sadran board and the member siddur grid, so kept here rather than under `sadranBoard.*`. */
    showEarlyHours: "הצג שעות מוקדמות",
    hideEarlyHours: "הסתר שעות מוקדמות",
    earlyMarkerTitle: "{{start}}–{{end}} (לפני טווח התצוגה)",
  },
  admin: {
    members: {
      pending: "ממתינים לאישור",
      import: "ייבוא",
    },
  },
  cars: {
    seatConfigs: "תצורות מושבים",
    quickCheck: "בדיקה מהירה",
  },
  destinations: {
    freeTextQueue: "טקסט חופשי לסיווג",
    ptScore: {
      "0": "אין",
      "1": "חלש מאוד",
      "2": "חלש",
      "3": "סביר",
      "4": "טוב",
      "5": "מצוין",
    },
  },
  policy: {
    weight: "משקל",
  },
  status: {
    draft: "טיוטה",
    submitted: "נשלחה",
    assigned: "שובצה",
    merged: "משולבת",
    proposed: "הצעה ממתינה",
    waitlisted: "ברשימת המתנה",
    denied: "לא שובצה",
    external: "פתרון חיצוני",
    withdrawn: "הוסרה",
    cancelled: "בוטלה",
  },
  flag: {
    late: "מאוחרת",
    changed: "שונתה",
  },
  ride: {
    pinned: "נעולה",
    conflict: "התנגשות",
    driver: "נהג/ת",
    chauffeur: "הסעה · מסיע/ה",
    /** Multi-day request leg marker (REQ §13.77, UX_FLOWS.md §3.5/§4.2), `tv()`. */
    seriesDay: "יום {{index}}/{{count}}",
  },
  // `ride_status` enum labels (StatusBadge kind: 'ride'); distinct from the
  // pin/conflict UI flags above, which overlay board blocks regardless of
  // the underlying ride_status value.
  rideStatus: {
    draft: "טיוטה",
    confirmed: "מאושרת",
    flagged: "מסומנת",
    cancelled: "בוטלה",
  },
  // `requests.status_reason` UPPER_SNAKE codes written by DB-native paths
  // (submit_request, try_auto_approve, cancel_ride, resolve_freed_offer, …
  // DATA_MODEL.md §3.6, §3.8 note 3) that have no TS caller to render Hebrew
  // via src/solver/reasons.ts. Grepped from supabase/migrations/*.sql; see
  // `STATUS_REASON_CODES` above. `satisfies` makes an added code with no
  // label fail typecheck.
  statusReason: {
    DUPLICATE_OVERLAP: "חופפת לנסיעה או לבקשה אחרת שלך",
    DUPLICATE_WITHDRAWN: "הסדרן/ית משך/ה את הבקשה ככפילות",
    ASK_TO_JOIN_TEMP_CAR: "בקשה להצטרף לנסיעה ברכב פרטי",
    AUTO_APPROVED: "אושרה אוטומטית — היה רכב פנוי",
    AUTO_APPROVED_FREE_CAR: "אושרה אוטומטית — הרכב היה פנוי",
    CANCELLED_BY_MEMBER: "בוטלה על ידך",
    DENIED_BY_SADRAN: "לא נמצא רכב מתאים",
    DRIVER_CLAIMED: "שובצת לנסיעה — נהג/ת התנדב/ה",
    EXTERNAL: "נבחר פתרון חיצוני",
    FREED_SLOT_APPROVED: "שובצת לרכב שהתפנה",
    FREED_SLOT_AUTO: "שובצת אוטומטית לרכב שהתפנה",
    NO_HOME_LOCATION: "לא הוגדר מיקום בית למחלקה",
    PROPOSAL_APPLIED: "יושמה הצעה של הסדרן/ית",
    PROPOSAL_APPLIED_PENDING_ASSIGNMENT: "ההצעה אושרה, ממתין לשיבוץ רכב",
    RIDE_CANCELLED: "הנסיעה בוטלה",
    SADRAN_ASSIGNED: "שובצה על ידי הסדרן/ית",
    SADRAN_EDIT: "עודכנה על ידי הסדרן/ית",
    SADRAN_MANUAL: "שובצה ידנית על ידי הסדרן/ית",
    SADRAN_UNASSIGNED: "השיבוץ הוסר על ידי הסדרן/ית — מחכה לשיבוץ מחדש",
    SERIES_CAR_UNAVAILABLE: "לא נמצא רכב פנוי לכל ימי ההזמנה הרב-יומית",
    SERIES_PLACED: "שובצה כחלק מהזמנה רב-יומית",
    UNMET_NEEDS_DRIVER: "הרכב שובץ, אך חסר/ה נהג/ת מתנדב/ת. תקבל/י הודעה כשיימצא נהג/ת.",
    UNSAFE_ISSUE: "הרכב הוצא משימוש עקב תקלה",
    SERIES_SHORTENED: "ההזמנה קוצרה לפי הצעת הסדרן — היום הזה לא נכלל",
    WAITLISTED_CONTESTED: "כמה חברים/ות מבקשים/ות רכב בשעות חופפות. אפשר לסמן ביניכם/ן מי נוסע/ת.",
    WAITLISTED_NOT_CHOSEN: "הפעם נוסע/ת חבר/ה אחר/ת. הבקשה נשארת ברשימת ההמתנה.",
    WAITLISTED_NO_CAR: "כל הרכבים תפוסים בשעות אלה. אם יתפנה רכב תקבל/י הודעה.",
    WAITLISTED_ONE_WAY: "נסיעה בכיוון אחד ממתינה לשיבוץ ידני",
    WAITLISTED_PUBLISHED_DAY: "היום הזה כבר פורסם. הבקשה ממתינה לרכב שיתפנה.",
    WAITLISTED_SERIES_NO_CAR: "אין רכב פנוי לכל ימי ההזמנה הרב-יומית. אם יתפנה רכב תקבל/י הודעה.",
    WAITLIST_RESOLVED: "שובץ אחרי דיון ברשימת ההמתנה",
    WAITLIST_RESOLVED_DRIVER: "שובצת כנהג/ת אחרי הדיון ברשימת ההמתנה",
    WAITLIST_RESOLVED_PASSENGER: "שובצת כנוסע/ת אחרי הדיון ברשימת ההמתנה",
    WITHDRAWN_BY_MEMBER: "הוסרה על ידך",
  } satisfies Record<StatusReasonCode, string>,
  // Generic fallback for a `status_reason` value that isn't in `statusReason`
  // above (e.g. a code added on the DB side before this file is updated) —
  // renderers must show this instead of the raw UPPER_SNAKE code.
  statusReasonUnknown: "עדכון סטטוס ללא פירוט",
  // SQLSTATE / RPC-message → Hebrew toast (src/lib/rpc.ts `toAppError`).
  errors: {
    staleVersion: "מישהו אחר שינה את זה בינתיים — טען/י את הגרסה החדשה ונסה/י שוב",
    staleInput: "הבקשות או הנסיעות השתנו מאז הרצת הפתרון — יש להריץ את הפתרון מחדש",
    notAuthorized: "אין לך הרשאה לבצע פעולה זו",
    publicationDrafts: "לא ניתן לפרסם — בימים שנבחרו יש טיוטות הצעה שלא נשלחו. יש לשלוח או למחוק אותן בלוח.",
    invalidRange: "טווח התאריכים אינו תקין (עד 400 ימים, סוף אחרי התחלה)",
    lastAdminRequired: "לא ניתן להסיר את ההרשאות של המנהל/ת האחרון/ה במערכת",
    weekNotOpen: "השבוע הזה סגור להגשת בקשות",
    oneWayCarModeRequired: "יש לבחור אופן נסיעה בכיוון אחד",
    /** REQ §88 (owner 2026-09-15): server-side guard — a member who marked "אני לא נוהג/ת" was placed as a driver/relay. */
    nonDriverCannotDrive: "חבר/ה שסימן/ה 'לא נוהג/ת' לא יכול/ה להיות נהג/ת",
    /** REQ §13.93: a non-driver with no driving companion may only file a הקפצה. */
    nonDriverNeedsDropOff: "מי שלא נוהג/ת יכול/ה לבקש רק הקפצה",
    originEqualsDestination: "מקום היציאה והיעד זהים — בחר/י יעד אחר או שנה/י את נקודת היציאה",
    joinOwnRide: "אי אפשר לבקש להצטרף לנסיעה שאת/ה כבר בה",
    /** REQ §13.95 (H3): `set_request_trip_type` — a round trip needs a return time. */
    tripTypeNeedsReturn: "אי אפשר לעבור להלוך-חזור — לבקשה אין שעת חזרה",
    /** REQ §13.93/SOLVER §3.15: accepting a `changeOrigin` proposal found the car/window no longer free. */
    originChangeUnavailable: "הרכב כבר לא פנוי בנקודת היציאה הזו — יש להריץ הצעה חדשה",
    carNotAtLegOrigin: "הרכב לא נמצא בנקודת היציאה בשעה הזו",
    carMoveInvalid: "העברת הרכב אינה תקינה (שעה, משך, מקום או אנשים)",
    carMoveSamePlace: "נקודת היעד זהה למקום שבו הרכב נמצא",
    legLocationMismatch: "מסלול הנסיעה אינו מתאים לבקשה (נקודת יציאה או יעד שונים)",
    carNextRideElsewhere: "הנסיעה הבאה של הרכב יוצאת ממקום אחר — הלוך בלבד היה משאיר אותו ביעד",
    carNotAtLegPlace: "הרכב לא נמצא באף אחד מקצות הנסיעה בשעה הזו",
    shiftCarInvalid: "הרכב שנבחר אינו פעיל במחלקה",
    noEligibleDriver: "אין בנסיעה הזו מי שיכול/ה לנהוג",
    /** REQ §13.93 "Multi-stop rides": submit_request()'s stops payload failed validation. */
    invalidStops: "פרטי העצירות אינם תקינים",
    invalidPlace: "המקום שנבחר אינו תקין",
    unmergeBaseRequest: "אי אפשר להוציא את הבקשה שהנסיעה נוצרה עבורה",
    joinLegsNotDropOff: "אפשר לחבר לנסיעה אחת רק הקפצה הלוך וחזור",
    joinLegsNotTwoRides: "אין שתי נסיעות נפרדות (הלוך ואיסוף) לחיבור",
    joinLegsSharedRide: "אחת הנסיעות משותפת עם בקשה אחרת — אי אפשר לחבר",
    joinLegsTwoDrivers: "לכל נסיעה כבר יש נהג/ת אחר/ת — אי אפשר לחבר",
    joinLegsOrder: "האיסוף מתחיל לפני שההקפצה מסתיימת — אי אפשר לחבר",
    joinLegsCarBusy: "אין רכב פנוי לכל משך הנסיעה המחוברת",
    requestNotOnRide: "הבקשה כבר אינה חלק מהנסיעה הזאת",
    manualBoostRequiresReason: "יש לציין סיבה להעדפה ידנית",
    requestNotFound: "הבקשה לא נמצאה",
    requestHasRide: "הבקשה כבר משובצת לנסיעה — יש לבטל את הנסיעה במקום למשוך את הבקשה",
    rideNotFound: "הנסיעה לא נמצאה",
    proposalNotFound: "ההצעה לא נמצאה",
    privateCarOwnerOnly: "רכב פרטי — רק הבעלים מוסיף/ה אליו בקשות (אפשר לבקש להצטרף אל הבעלים)",
    ownCarNotFree: "הרכב הפרטי שלך לא פנוי בשעות האלה",
    ownCarRoundTripOnly: "אפשר לשבץ על הרכב הפרטי רק נסיעה הלוך-חזור",
    proposalDayPublic: "היום כבר פורסם — אפשר לשלוח רק הצעה להזזת שעה או לצירוף; בשאר המקרים מתאמים ישירות",
    carNowWeekNotLive: "רכב עכשיו אפשרי רק אחרי שהסידור של השבוע הנוכחי פורסם",
    carChainBroken: "לוח הזמנים של הרכב לא רציף",
    carAwayAtDayEnd: "הרכב לא חוזר הביתה בזמן",
    noHomeLocation: "לא הוגדר מיקום בית למחלקה",
    noCarFree: "אין רכב פנוי לחלון הזמן המבוקש",
    waitlistGroupClosed: "הדיון על הרכב כבר הוכרע",
    waitlistSelectionInvalid: "הבחירה אינה תקפה — יש לרענן ולנסות שוב",
    seriesWeekNotOpen: "אפשר לשמור רכב עד שישה שבועות קדימה, ולא לימים שכבר עברו",
    seriesEditNotSupported: "בקשה רב-יומית אפשר לבטל ולהגיש מחדש, לא לערוך",
    seriesCarUnavailable: "הרכב לא פנוי לכל ימי הבקשה הרב-יומית",
    rideDriverNotAssignable: "אי אפשר לשנות את הנהג/ת של הנסיעה הזו",
    driverNotMember: "הנהג/ת שנבחר/ה אינו/ה חבר/ה במחלקה",
    luggageCapacityViolation: "לרכב אין תא מטען גדול לציוד של הבקשה הזו",
    rideSeatsExceeded: "אין מספיק מקום ברכב לכל האנשים שנבחרו",
    invalidRidePassenger: "פרטי הנוסע/ת אינם תקינים",
    rideDriverNotRemovable: "לא ניתן להסיר את הנהג/ת מהנסיעה — יש לבטל את הנסיעה במקום זאת",
    rideWeekNotPublic: "אפשר להוסיף או להסיר נוסעים רק בשבוע שפורסם",
    dayCarSwapBlocked: "החילוף נחסם — נתוני היום השתנו בינתיים, יש לפתוח את החלון הזה מחדש",
    network: "אין חיבור לרשת — נסה/י שוב",
    unknown: "אירעה שגיאה. נסה/י שוב",
    constraintViolation: "הנתונים לא עומדים בכללי המערכת — בדוק/י את השדות",
    duplicateValue: "ערך כזה כבר קיים",
    errorCode: "קוד תקלה",
    pushUnsupported: "המכשיר או הדפדפן אינם תומכים בהתראות",
    pushPermissionDenied: "ההרשאה להתראות חסומה בהגדרות המכשיר או הדפדפן",
    pushVapidKeyInvalid: "הגדרת ההתראות באתר אינה תקינה",
    pushServiceWorkerTimeout: "הכנת ההתראות במכשיר ארכה זמן רב מדי",
    pushSubscriptionIncomplete: "לא התקבלו פרטי הרשמה מלאים להתראות",
    pushSubscriptionFailed: "לא ניתן להירשם להתראות במכשיר הזה",
    invalidEmail: "כתובת אימייל לא תקינה",
  },
  proposalStatus: {
    draft: "טיוטה",
    sent: "נשלחה",
    accepted: "אושרה",
    declined: "נדחתה",
    expired: "פקעה",
    withdrawn: "בוטלה",
    applied: "יושמה",
  },
  phase: {
    upcoming: "טרם נפתח",
    open: "פתוח לבקשות",
    solving: "בהכנה",
    published: "פורסם",
    live: "פעיל",
    archived: "בארכיון",
  },
  // The single notification_event → Hebrew label map (docs/REFACTOR_BACKLOG.md
  // §5.3 — this used to be duplicated as `notificationEventLabels` in
  // `he.admin.ts`, deleted). Used by the mute list / inbox filters and by
  // the admin templates screen (`he.notif[event]`). Message copy itself
  // comes from the DB-seeded `notification_templates` table, not from here.
  // Keyed by the DB enum's own snake_case values (not this file's usual
  // camelCase) so lookups by a typed `notification_event` value work
  // directly, and `satisfies Record<NotificationEvent, string>` below makes
  // a missing/added enum literal fail `npm run typecheck`.
  notif: {
    window_open: "נפתח חלון בקשות",
    window_closing: "חלון הבקשות נסגר בקרוב",
    window_closed_solve_now: "הבקשות נסגרו — להריץ פותר",
    publish_reminder: "תזכורת לפרסום",
    published: "הסידור פורסם",
    outcome_changed: "הבקשה שלך השתנתה",
    proposal_received: "הצעה מהסדרן/ית",
    proposal_answered: "תשובה להצעה",
    freed_slot: "מקום התפנה",
    freed_slot_auto: "מקום שובץ אוטומטית",
    claim_approved: "בקשת הצטרפות אושרה",
    claim_declined: "בקשת הצטרפות נדחתה",
    claim_contested: "כמה בקשות למקום שהתפנה",
    maintenance_affects: "טיפול רכב משפיע על נסיעה",
    late_request: "בקשה מאוחרת",
    waitlisted_request: "בקשה ברשימת המתנה",
    auto_approved: "שובץ אוטומטית",
    request_changed: "בקשה עודכנה",
    access_request: "בקשת הרשמה חדשה",
    access_approved: "ההרשמה אושרה",
    status_changed: "שינוי בסטטוס או בתפקיד",
    car_care: "טיפול ברכב",
    waitlist_contested: "רשימת המתנה משותפת",
    waitlist_resolved: "רשימת ההמתנה הוסדרה",
    window_changed: "מועד סגירת הבקשות השתנה",
    car_swapped: "הרכב שלך הוחלף",
  } satisfies Record<NotificationEvent, string>,
  car: {
    status: {
      active: "פעיל",
      maintenance: "בטיפול",
      retired: "הוצא משימוש",
    },
    type: {
      shared: "משותף",
      temporary: "רכב פרטי",
    },
  },
  days: {
    short: ["א", "ב", "ג", "ד", "ה", "ו", "ש"] as readonly string[],
    /** Geresh (U+05F3) appended after a short weekday letter, e.g. "ד׳" — kept
     * here so `formatDayDate` (`src/lib/dayLabels.ts`) never inlines Hebrew. */
    geresh: "׳",
    long: [
      "ראשון",
      "שני",
      "שלישי",
      "רביעי",
      "חמישי",
      "שישי",
      "שבת",
    ] as readonly string[],
  },
  common: {
    cancel: "ביטול",
    confirm: "אישור",
    save: "שמירה",
    back: "חזרה",
    retry: "נסה/י שוב",
    loading: "טוען…",
    notFound: "הדף לא נמצא",
    backHome: "חזרה לדף הבית",
    skipToContent: "דלג לתוכן הראשי",
  },
  offline: {
    banner: "אין חיבור לאינטרנט — מוצג הסידור האחרון שנשמר",
  },
} as const;

export type Dictionary = typeof he;

type DotPaths<T> = T extends string
  ? never
  : T extends readonly unknown[]
    ? never
    : {
        [K in keyof T & string]: T[K] extends string
          ? K
          : T[K] extends readonly unknown[]
            ? never
            : `${K}.${DotPaths<T[K]>}`;
      }[keyof T & string];

/**
 * Dot-path keys for every Hebrew string leaf (excludes array leaves like
 * `days.short`/`days.long`, which are read directly off `he` instead).
 */
export type TranslationKey = DotPaths<Dictionary>;

function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc !== null && typeof acc === "object" && segment in acc) {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, source);
}

/** Looks up a Hebrew string (or string array, e.g. `days.short`) by dot-path key. */
export function t(key: TranslationKey): string {
  const value = getByPath(he, key);
  if (typeof value !== "string") {
    throw new Error(`Missing i18n key: "${key}"`);
  }
  return value;
}

/**
 * Looks up a Hebrew string and substitutes `{{name}}` placeholders (the
 * convention used throughout UX_FLOWS.md §6/§7). A minimal, additive
 * complement to `t()` for the handful of screen strings that carry
 * variables (`home.emptyRequestsOpen`, …) — most screens compose the
 * dynamic part (a name, a time) as a separate `<span dir="ltr">` instead.
 */
export function tv(key: TranslationKey, vars: Record<string, string>): string {
  return t(key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars[name] ?? "");
}
