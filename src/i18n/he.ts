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

export const he = {
  ...heMember,
  ...heAdmin,
  ...heSadran,
  app: {
    name: "סידור רכב — נבו",
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
    submitRequest: "שלח/י בקשה",
    saveRequest: "שמור/י שינויים",
    withdrawRequest: "הסר בקשה",
    cancelRide: "בטל נסיעה",
    askToJoin: "בקש/י להצטרף",
    reportIssue: "דווח/י על תקלה ברכב",
    acceptProposal: "מקבל/ת את ההצעה",
    declineProposal: "לא מתאים לי",
    suggestOtherTime: "להציע שעה אחרת",
    understood: "הבנתי",
    foundExternal: "מצאתי פתרון אחר",
    markAllRead: "סמן הכול כנקרא",
    stillWant: "אני עדיין רוצה",
    registerTempCar: "רשום רכב",
    addOwnRide: "הוסף נסיעה",
    signOut: "התנתקות",
    closeWindow: "סגור חלון עכשיו",
    runSolver: "הרץ פותר",
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
    destinationFreeText: "יעד חופשי",
    rideType: "סוג נסיעה",
    day: "יום",
    depart: "יציאה",
    return: "חזרה",
    roundTrip: "הלוך ושוב",
    oneWay: "כיוון אחד",
    oneWayTo: "לשם",
    oneWayFrom: "חזרה",
    carAtDestination: "הרכב נשאר איתי ביעד",
    passengers: "נוסעים",
    adults: "מבוגרים (כולל נהג/ת)",
    childSeats: "ילדים במושב בטיחות",
    boosters: "ילדים בבוסטר",
    companions: "חברים שנוסעים איתך",
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
    },
    optOutFreed: "אל תציעו לי מקומות שמתפנים השבוע",
    recorded: {
      accepted: "אישר/ה",
      declined: "דחה/תה",
    },
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
  // via src/solver/reasons.ts. Grepped from supabase/migrations/20260907091500_rpc.sql.
  statusReason: {
    ASK_TO_JOIN_TEMP_CAR: "בקשה להצטרף לנסיעה ברכב פרטי",
    AUTO_APPROVED: "אושרה אוטומטית — היה רכב פנוי",
    AUTO_APPROVED_FREE_CAR: "אושרה אוטומטית — הרכב היה פנוי",
    CANCELLED_BY_MEMBER: "בוטלה על ידך",
    DENIED_BY_SADRAN: "לא נמצא רכב מתאים",
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
    UNSAFE_ISSUE: "הרכב הוצא משימוש עקב תקלה",
    WAITLISTED_NO_CAR: "כל הרכבים תפוסים בשעות אלה. אם יתפנה רכב תקבל/י הודעה.",
    WAITLISTED_ONE_WAY: "נסיעה בכיוון אחד ממתינה לשיבוץ ידני",
    WITHDRAWN_BY_MEMBER: "הוסרה על ידך",
  },
  // SQLSTATE / RPC-message → Hebrew toast (src/lib/rpc.ts `toAppError`).
  errors: {
    staleVersion: "מישהו אחר שינה את זה בינתיים — טען/י את הגרסה החדשה ונסה/י שוב",
    staleInput: "הבקשות או הנסיעות השתנו מאז הרצת הפתרון — יש להריץ את הפתרון מחדש",
    notAuthorized: "אין לך הרשאה לבצע פעולה זו",
    weekNotOpen: "השבוע הזה סגור להגשת בקשות",
    oneWayCarModeRequired: "יש לבחור אופן נסיעה בכיוון אחד",
    manualBoostRequiresReason: "יש לציין סיבה להעדפה ידנית",
    requestNotFound: "הבקשה לא נמצאה",
    rideNotFound: "הנסיעה לא נמצאה",
    proposalNotFound: "ההצעה לא נמצאה",
    carChainBroken: "לוח הזמנים של הרכב לא רציף",
    carAwayAtDayEnd: "הרכב לא חוזר הביתה בזמן",
    noHomeLocation: "לא הוגדר מיקום בית למחלקה",
    network: "אין חיבור לרשת — נסה/י שוב",
    unknown: "אירעה שגיאה. נסה/י שוב",
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
    open: "פתוח לבקשות",
    solving: "בהכנה",
    published: "פורסם",
    live: "פעיל",
    archived: "בארכיון",
  },
  // Short event labels for the mute list / inbox filters (18 canonical
  // events, UX_FLOWS §6.1). Message copy itself comes from the DB-seeded
  // `notification_templates` table, not from here.
  notif: {
    windowOpen: "נפתח חלון בקשות",
    windowClosing: "חלון הבקשות נסגר בקרוב",
    published: "הסידור פורסם",
    outcomeChanged: "הבקשה שלך השתנתה",
    proposalReceived: "הצעה מהסדרן/ית",
    proposalAnswered: "תשובה להצעה",
    freedSlot: "מקום התפנה",
    freedSlotAuto: "מקום שובץ אוטומטית",
    claimApproved: "בקשת הצטרפות אושרה",
    claimDeclined: "בקשת הצטרפות נדחתה",
    claimContested: "כמה בקשות למקום שהתפנה",
    maintenanceAffects: "טיפול רכב משפיע על נסיעה",
    lateRequest: "בקשה מאוחרת",
    waitlistedRequest: "בקשה ברשימת המתנה",
    autoApproved: "שובץ אוטומטית",
    requestChanged: "בקשה עודכנה",
    accessRequest: "בקשת הרשמה חדשה",
    accessApproved: "ההרשמה אושרה",
  },
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
