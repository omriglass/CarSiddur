/**
 * All-cars dashboard (REQ item 150 e, `/cars`): one row per shared car for car administrators and admins.
 * Own module (spread into `he.ts`) so the concurrent car-administration work does not edit the same lines.
 */
export const heCarsOverview = {
  carsOverview: {
    title: "כל הרכבים",
    subtitle: "מצב הרכבים המשותפים במחלקה",
    navLabel: "כל הרכבים",
    adminCardSubtitle: "קילומטראז׳, בדיקת רכב, צמיגים ושטיפה של כל הרכבים המשותפים",
    notAuthorized: "רק מנהלי/ות רכבים ומנהלי/ות מערכת יכולים לצפות בעמוד הזה",
    empty: "אין רכבים משותפים פעילים במחלקה",
    refresh: "רענון",
    colCar: "רכב",
    colKm: "קילומטראז׳",
    colChecklist: "בדיקת רכב",
    colTires: "מילוי אוויר",
    colWash: "שטיפה",
    colStatus: "סטטוס",
    replacement: "רכב חלופי",
    noData: "אין נתונים",
    noReading: "אין קריאה",
    neverDone: "טרם בוצע",
    checklistGreen: "תקין ב-{{date}}",
    checklistNotGreen: "לא תקין ב-{{date}}",
    checklistFailedTitle: "מה לא תקין",
    checklistNone: "טרם בוצעה בדיקה",
    tireOk: "תקין",
    tireLow: "נוספו 2–5 PSI",
    tireVeryLow: "נוספו מעל 5 PSI",
    tireUnchecked: "לא נבדק",
  },
} as const;
