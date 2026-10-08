// src/solver/reasons.ts
//
// The ONLY file under src/solver that contains Hebrew (CLAUDE.md hard rule 3).
// Holds: reason templates keyed by reasonCode, rule descriptions (RULE_<TYPE>_DESC)
// and PolicyParamsError messages. Rule files call `ruleDescription()` /
// `paramsErrorMessage()` and never inline Hebrew themselves.

/** Reason templates. `{name}` placeholders are substituted by `reason()`. */
const TEMPLATES: Record<string, string> = {
  // Assignment reasons
  PLACED_PREFERRED: 'שובץ ל{car} בזמן המבוקש',
  PLACED_SHIFTED: "שובץ ל{car} עם הזזה של {dep} דק' ביציאה ו-{ret} דק' בחזרה, בתוך הגמישות שהוצהרה",
  PLACED_RELAY_PAIR: 'שובץ ל{car}: {member} נוהג/ת ל{dest} ב-{dep} ומשאיר/ה את הרכב; {partner} מחזיר/ה אותו ב-{ret}',
  PLACED_FIXED: 'נסיעה קבועה שנקבעה מראש',
  PLACED_SERIES: 'שובץ/ה כחלק מבקשה רב-יומית ל{car} ({index}/{count})',
  CAR_BALANCED_MILEAGE: 'נבחר {car} לאיזון קילומטראז׳ בין הרכבים',
  PLACED_NEEDS_DRIVER: 'שובץ ל{car} ללא נהג/ת קבוע/ה; דרוש/ה מתנדב/ת או אורח/ת שיסיע/תסיע',
  PLACED_PICKUP_FROM_CAR_AT_X: 'שובץ ל{car}: הרכב כבר ב{place}; המבקש/ת נוהג/ת בו הביתה ומגיע/ה ב-{ret}',
  PLACED_CHAUFFEUR_NO_RETURNER:
    'שובץ ל{car} כהסעה ל{dest} ({dep}–{ret}): לא נמצא/ה מי שמחזיר/ה את הרכב; דרוש/ה נהג/ת מתנדב/ת',

  // Unmet reasons
  UNMET_NEEDS_LARGE_TRUNK: 'צריך רכב עם תא מטען גדול',
  UNMET_NO_CAR: 'אין רכב פנוי בחלון המבוקש; חוסמים: {blockers}',
  UNMET_NO_CAR_NONE: 'אין רכבים משותפים זמינים לשיבוץ',
  UNMET_NO_CAR_BUSY: 'כל הרכבים תפוסים בחלון המבוקש',
  UNMET_NO_CAR_SEATS: 'אין רכב עם מספיק מקומות ישיבה לנוסעים (כולל הנהג/ת)',
  UNMET_NO_CAR_SEATS_BUSY: 'כל הרכבים עם מושבי ילדים מתאימים תפוסים בזמן הנסיעה',
  UNMET_NO_CAR_LUGGAGE: 'אין רכב עם תא מטען מתאים לכמות המטען',
  UNMET_NO_RELAY_PARTNER: 'אין מי שיחזיר/יביא את הרכב מ{dest}: לא נמצא/ה נהג/ת שיחזיר/ה אותו, והנסיעה בכיוון אחד תשאיר אותו שם',
  UNMET_NEEDS_DRIVER: 'אין נסיעה מתאימה להצטרף אליה; דרוש/ה נהג/ת מתנדב/ת להסעה ל{dest}',
  UNMET_SERIES_NO_CAR: 'אין רכב פנוי לכל ימי הבקשה הרב-יומית ({index}/{count})',
  UNMET_NO_CAR_AT_ORIGIN: 'אין רכב פנוי שנמצא ב{origin} כדי לצאת משם ל{dest}',
  UNMET_FREE_TEXT_ORIGIN: 'נקודת היציאה היא טקסט חופשי ולא מקום מוכר; לא ניתן לשבץ נסיעה ממנה אוטומטית',

  // Suggestions
  SUGGEST_SHIFT_WITHIN_FLEX: 'הזזה ל{car} בתוך הגמישות שהוצהרה, ללא צורך בהסכמה נוספת',
  SUGGEST_MERGE: 'הצטרפות לנסיעה של {host} ל{dest} ביציאה {dep} ובחזרה {ret}, ללא סטייה',
  SUGGEST_MERGE_DETOUR: 'הצטרפות לנסיעה של {host} ל{dest} ביציאה {dep} ובחזרה {ret}, עם סטייה של כ-{minutes} דק׳',
  SUGGEST_BEYOND_FLEX: "הזזה של {dep} דק' מעבר לגמישות שהוצהרה — דורש הסכמה",
  SUGGEST_SPLIT_LEGS: 'פיצול הנסיעה: הלוך {outbound} וחזור {return} בנפרד — דורש הסכמה',
  SUGGEST_ROUND_TRIP: 'במקום להשאיר את הרכב ב{dest}: לקחת אותו הלוך ושוב ולחזור ב-{ret} — דורש הסכמה',
  SUGGEST_CHAUFFEUR: 'הסעה: נהג/ת מתנדב/ת מסיע/ה ל{dest} ב-{dep} וחוזר/ת עם הרכב (כ-{minutes} דק׳); הסדרן/ית משבץ/ת נהג/ת',
  SUGGEST_CHANGE_ORIGIN: 'יש רכב פנוי ב{origin} לאורך כל החלון המבוקש; ניתן להציע יציאה מ{origin} עם {car} — דורש הסכמה',
  SUGGEST_CHAIN_ONE_WAY: '{car} נשאר/ת ב{place} אחרי הנסיעה של {member}; אפשר לשבץ אותך עליו/ה ל{dest} ב-{dep} — דורש הסכמה',
  SUGGEST_CHAIN_ONE_WAY_ANON: '{car} נשאר/ת ב{place} אחרי נסיעה קודמת; אפשר לשבץ אותך עליו/ה ל{dest} ב-{dep} — דורש הסכמה',
  SUGGEST_USE_ALTERNATIVE: 'תוכנית ב׳ של המבקש/ת: הקפצה ל{place} עד {arrive}{pickup} — דורש הסכמה',
  SUGGEST_USE_ALTERNATIVE_PICKUP: ', ואיסוף משם ב-{pickup}',
  SUGGEST_USE_ALTERNATIVE_PICKUP_FROM: ', ואיסוף מ{pickupPlace} ב-{pickup}',
  SUGGEST_EXTERNAL_CAB: 'ניתן להסתדר במונית לנסיעה זו',
  SUGGEST_EXTERNAL_RENTAL: 'משך הנסיעה ארוך; כדאי לשקול השכרת רכב',
  SUGGEST_EXTERNAL_PT: 'יש תחבורה ציבורית סבירה ל{dest}',
  SUGGEST_DENY: 'לא נמצא פתרון; ניתן לדחות עם הסבר',

  // Normalization warnings (message text; code stays the machine key)
  WARN_TIME_NOT_ALIGNED: 'זמן הבקשה אינו מיושר לרבע שעה',
  WARN_NO_CAR_FITS_SEATS: 'אין רכב פעיל שמתאים למספר הנוסעים המבוקש',
  // WARN_FIXED_RIDE_LOCATION_MISMATCH / WARN_CAR_AWAY_AT_DAY_END retired with
  // the day-end rule (REQUIREMENTS §13.93) — superseded by WARN_CHAIN_BROKEN
  // (CarTimeline.chainBreaks()) and WARN_CAR_AWAY_AT_WEEK_END below.
  WARN_CHAIN_BROKEN: 'נסיעה קבועה מתחילה במקום שהרכב אינו נמצא בו בפועל',
  WARN_FIXED_RIDE_CONFLICT: 'נסיעה קבועה חופפת או צמודה מדי לנסיעה קבועה אחרת באותו רכב',
  WARN_CAR_AWAY_AT_WEEK_END: '{car} מסיים/ת את השבוע ב{place} ולא בבסיסו/ה',
  WARN_UNKNOWN_RULE_TYPE: 'סוג כלל מדיניות לא מוכר; הכלל דולג',
};

/** Rule descriptions shown in the admin UI (RULE_<TYPE>_DESC). */
const RULE_DESCRIPTIONS: Record<string, string> = {
  RULE_RIDETYPE_DESC: 'מעניק עדיפות לפי סוג הנסיעה, לפי משקל שהוגדר לכל סוג נסיעה (וברירת מחדל לסוג נסיעה ללא משקל מוגדר)',
  RULE_DISTANCE_DESC: 'מעניק עדיפות ליעדים רחוקים יותר, בהם פחות חלופות',
  RULE_PUBLICTRANSPORT_DESC: 'מעניק עדיפות נמוכה יותר ליעדים עם תחבורה ציבורית טובה',
  RULE_PEOPLESERVED_DESC: 'מעניק עדיפות לנסיעות שמשרתות יותר אנשים (כולל זוג ממסר)',
  RULE_FAIRNESS_DESC: 'מעניק עדיפות לחברים שקיבלו פחות שעות נסיעה מאושרות בשבועות האחרונים',
  RULE_SUBMISSIONTIME_DESC: 'מעניק יתרון קל להגשה מוקדמת וקנס להגשה מאוחרת',
  RULE_FLEXIBILITYOFFERED_DESC: 'מעניק בונוס להצהרת גמישות בזמנים',
  RULE_MANUALBOOST_DESC: 'בונוס חד-פעמי שניתן ידנית על ידי הסדרן/ית',
};

/** PolicyParamsError messages keyed by error code. */
const PARAM_ERRORS: Record<string, string> = {
  RIDETYPE_WEIGHTS_INVALID: 'פרמטר weights חסר או שגוי בכלל rideType',
  RIDETYPE_DEFAULTWEIGHT_INVALID: 'פרמטר defaultWeight שגוי בכלל rideType',
  DISTANCE_MAXKM_INVALID: 'פרמטר maxKm חסר או שגוי בכלל distance',
  PEOPLESERVED_CAP_INVALID: 'פרמטר cap חסר או שגוי בכלל peopleServed',
  FAIRNESS_LOOKBACK_INVALID: 'פרמטר lookbackWeeks חסר או שגוי בכלל fairness',
  FAIRNESS_ALT_WEIGHT_INVALID: 'פרמטר alternativeServedWeight שגוי בכלל fairness (חייב להיות בין 0 ל-1)',
  SUBMISSIONTIME_LATEPENALTY_INVALID: 'פרמטר latePenalty חסר או שגוי בכלל submissionTime',
  FLEXIBILITYOFFERED_MINUTES_INVALID: 'פרמטר fullCreditMinutes חסר או שגוי בכלל flexibilityOffered',
};

const ALL: Record<string, string> = { ...TEMPLATES, ...RULE_DESCRIPTIONS, ...PARAM_ERRORS };

/**
 * Renders the Hebrew template for `code`, substituting `{key}` placeholders
 * from `params`. Unknown placeholders are left as-is; an unknown code falls
 * back to the code itself so a missing template never throws.
 */
export function reason(code: string, params: Record<string, string | number> = {}): string {
  const template = ALL[code];
  if (template === undefined) return code;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/** Hebrew description of a rule type, for the admin policy editor. */
export function ruleDescription(code: string): string {
  return reason(code);
}

/** Hebrew message for a PolicyParamsError, keyed by error code. */
export function paramsErrorMessage(code: string): string {
  return reason(code);
}

export const reasonCodes = Object.keys(ALL);
