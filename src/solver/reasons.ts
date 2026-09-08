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
  PLACED_SHIFTED: 'שובץ ל{car} עם הזזה של {dep} ביציאה ו-{ret} בחזרה, בתוך הגמישות שהוצהרה',
  PLACED_RELAY_PAIR: 'שובץ ל{car}: {member} נוהג/ת ל{dest} ב-{dep} ומשאיר/ה את הרכב; {partner} מחזיר/ה אותו ב-{ret}',
  PLACED_FIXED: 'נסיעה קבועה שנקבעה מראש',
  RELOCATED_FOR: 'הועבר ל{car} כדי לפנות מקום לבקשה של {member}',
  RELOCATED_FOR_SHIFT: 'הוזז ב-{minutes} דקות כדי לפנות מקום לבקשה של {member}',

  // Unmet reasons
  UNMET_NO_CAR: 'אין רכב פנוי בחלון המבוקש; חוסמים: {blockers}',
  UNMET_NO_RELAY_PARTNER: 'אין מי שיחזיר/יביא את הרכב מ{dest} באותו יום; הרכב חייב לחזור הביתה עד {dayEnd}',
  UNMET_NEEDS_DRIVER: 'אין נסיעה מתאימה להצטרף אליה; דרוש/ה נהג/ת מתנדב/ת להסעה ל{dest} ב-{dep}',
  UNMET_CAR_AWAY: '{car} נמצא/ת ב{location} בשעות האלה ולא זמין/ה מהבית',

  // Suggestions
  SUGGEST_SHIFT_WITHIN_FLEX: 'הזזה ל{car} בתוך הגמישות שהוצהרה, ללא צורך בהסכמה נוספת',
  SUGGEST_MERGE: 'הצטרפות לנסיעה של {host} ל{dest} ביציאה {dep} ובחזרה {ret}, ללא סטייה',
  SUGGEST_MERGE_DETOUR: 'הצטרפות לנסיעה של {host} ל{dest} ביציאה {dep} ובחזרה {ret}, עם סטייה של כ-{minutes} דק׳',
  SUGGEST_MERGE_LEG: 'הצטרפות כנוסע/ת לנסיעה של {host} {direction} {dest} ב-{time}',
  SUGGEST_BEYOND_FLEX: 'הזזה של {dep} מעבר לגמישות שהוצהרה — דורש הסכמה',
  SUGGEST_SPLIT_LEGS: 'פיצול הנסיעה: הלוך {outbound} וחזור {return} בנפרד — דורש הסכמה',
  SUGGEST_ROUND_TRIP: 'במקום להשאיר את הרכב ב{dest}: לקחת אותו הלוך ושוב ולחזור ב-{ret} — דורש הסכמה',
  SUGGEST_CHAUFFEUR: 'הסעה: נהג/ת מתנדב/ת מסיע/ה ל{dest} ב-{dep} וחוזר/ת עם הרכב (כ-{minutes} דק׳); הסדרן/ית משבץ/ת נהג/ת',
  SUGGEST_EXTERNAL_CAB: 'ניתן להסתדר במונית לנסיעה זו',
  SUGGEST_EXTERNAL_RENTAL: 'משך הנסיעה ארוך; כדאי לשקול השכרת רכב',
  SUGGEST_EXTERNAL_PT: 'יש תחבורה ציבורית סבירה ל{dest}',
  SUGGEST_DENY: 'לא נמצא פתרון; ניתן לדחות עם הסבר',

  // Normalization warnings (message text; code stays the machine key)
  WARN_TIME_NOT_ALIGNED: 'זמן הבקשה אינו מיושר לרבע שעה',
  WARN_NO_CAR_FITS_SEATS: 'אין רכב פעיל שמתאים למספר הנוסעים המבוקש',
  WARN_ONE_WAY_MODE_MISSING: 'לא הוגדר אופן רכב לנסיעת כיוון אחד; הוגדר כברירת מחדל כנוסע/ת',
  WARN_FIXED_RIDE_LOCATION_MISMATCH: 'מיקום הרכב בתחילת הנסיעה הקבועה אינו תואם את מיקומו בפועל',
  WARN_CAR_AWAY_AT_DAY_END: 'הרכב אינו חוזר הביתה עד סוף היום ולא אושרה השארה למחר',
  WARN_UNKNOWN_RULE_TYPE: 'סוג כלל מדיניות לא מוכר; הכלל דולג',
};

/** Rule descriptions shown in the admin UI (RULE_<TYPE>_DESC). */
const RULE_DESCRIPTIONS: Record<string, string> = {
  RULE_RIDETYPE_DESC: 'מעניק עדיפות לפי סוג הנסיעה (למשל בריאות גבוה מסידורים)',
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
  DISTANCE_MAXKM_INVALID: 'פרמטר maxKm חסר או שגוי בכלל distance',
  PUBLICTRANSPORT_PARAMS_INVALID: 'פרמטרים שגויים בכלל publicTransport',
  PEOPLESERVED_CAP_INVALID: 'פרמטר cap חסר או שגוי בכלל peopleServed',
  FAIRNESS_LOOKBACK_INVALID: 'פרמטר lookbackWeeks חסר או שגוי בכלל fairness',
  SUBMISSIONTIME_LATEPENALTY_INVALID: 'פרמטר latePenalty חסר או שגוי בכלל submissionTime',
  FLEXIBILITYOFFERED_MINUTES_INVALID: 'פרמטר fullCreditMinutes חסר או שגוי בכלל flexibilityOffered',
  MANUALBOOST_PARAMS_INVALID: 'פרמטרים שגויים בכלל manualBoost',
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
