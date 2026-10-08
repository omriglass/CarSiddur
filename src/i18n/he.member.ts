/**
 * Member-facing Hebrew strings for stage 2a (request form, my requests list,
 * published siddur, proposal screen, inbox extras, profile extras, push/temp
 * car). Kept in its own module so the concurrent admin-screens stage can add
 * `he.admin.ts` without both agents editing the same lines of `src/i18n/he.ts`
 * (only a single `...heMember` spread + import lands there). Everything here
 * is additive: new top-level namespaces that do not exist yet in `he.ts`
 * (CLAUDE.md hard rule 3 — Hebrew lives only in `he.ts`/`he.*.ts`, solver
 * reasons.ts, and seeded DB data).
 */
export const heMember = {
  /** Glue used by `src/lib/rideLabel.ts` to compose "<who> ל<place>" / "<who> מ<place>" and Hebrew lists. */
  rideLabel: {
    /** Conjunction prefixed to the last list item: "א, ב וג". */
    and: "ו",
    /** Direction prefix for a leg that ends at the named place. */
    to: "ל",
    /** Direction prefix for a leg that starts at the named place (one-way-from). */
    from: "מ",
  },
  excelExport: {
    button: "ייצוא לאקסל", loading: "מכין קובץ…", requestsSheet: "בקשות", boardSheet: "סידור", scoresSheet: "ניקוד בפרסום",
    requestId: "מזהה בקשה", rideId: "מזהה נסיעה", requester: "מבקש/ת", status: "מצב", destination: "יעד הבקשה",
    tripShape: "כיוון הנסיעה", depart: "יציאה — שעון ישראל", returning: "חזרה — שעון ישראל", driver: "נהג/ת", car: "רכב",
    needsDriver: "דרוש/ה נהג/ת", passengers: "נוסעים", adults: "מבוגרים", childSeats: "כיסאות ילדים", boosters: "בוסטרים",
    luggage: "מטען", notes: "הערות", preferredCar: "רכב מועדף", origin: "מיקום הרכב בתחילה", carEnd: "מיקום הרכב בסיום",
    startsAt: "תחילת נסיעה — שעון ישראל", endsAt: "סיום נסיעה — שעון ישראל", blockedUntil: "תפוס עד — שעון ישראל",
    flexDepartEarly: "גמישות מוקדם ביציאה", flexDepartLate: "גמישות מאוחר ביציאה", flexReturnEarly: "גמישות מוקדם בחזרה", flexReturnLate: "גמישות מאוחר בחזרה",
    policy: "מדיניות", policyVersion: "מזהה גרסת מדיניות", profile: "חבר/ה", score: "ניקוד", served: "שובצה בפרסום", publishedAt: "פורסם — שעון ישראל",
    ruleBreakdown: "פירוט כללים", week: "תחילת שבוע", department: "מזהה מחלקה", noDriver: "ללא נהג/ת", selectedPolicy: "המדיניות שנבחרה בפרסום",
    noScores: "אין ניקוד שמור לפרסום בשבוע הזה", yes: "כן", no: "לא",
    /** Multi-day request leg index/count column (REQ §13.77, UX_FLOWS.md §4.2). */
    seriesDay: "יום ברב-יומי",
    /** Week-grid "סידור" sheet (one table per day, a column per car). */
    dayTitle: "יום {{date}}",
    timeColumn: "שעה",
    requestInWords: "הבקשה במילים",
    timeRange: "{{start}}–{{end}}",
    /** Requests sheet: "הבקשה במילים" — the request as the sentence form reads it, plus every modifier. */
    sentence: {
      onDay: "ביום {{day}}",
      flex: "גמישות {{brief}}",
      flexOut: "גמישות ביציאה {{brief}}",
      flexReturn: "גמישות בחזרה {{brief}}",
      preferredCar: "עדיפות לרכב {{name}}",
    },
  },
  /**
   * F2 (docs/TODO.md 2026-09-14): the shared three/four-state "בקשה חדשה" button
   * (`src/features/requests/newRequestButton.ts` / `NewRequestButton`) — `he.action.newRequest`
   * stays for anything still using the old always-on label (none left after this change, kept
   * per the task's "keep the old key if anything else uses it").
   *
   * The 4th state (only the live week exists, nothing newer open yet) reuses `nextWeek`'s own
   * label, disabled — the button always reads as being about *next* week, never "this week"
   * (owner decision 2026-09-14, same day as the original three/four-state change).
   */
  newRequestButton: {
    // Owner 2026-09-14 (second revision): the open state reads plainly "בקשה חדשה"; the
    // button still always refers to next week.
    nextWeek: "בקשה חדשה",
    preparing: "סידור בהכנה...",
    waitlistNextWeek: "רשימת המתנה לשבוע הבא",
  },
  request: {
    legStateLine: "הלוך: {{out}} · חזור: {{ret}}",
    legPlaced: "שובץ",
    legWaiting: "ממתין",
    namedPassengerCount: "נוסעים מבוגרים: {{count}} (כולל אותך)",
    namedChildCount: "ילדים: {{count}}",
    waitlistBanner: "הבקשה תיכנס לרשימת ההמתנה ליום שכבר פורסם. אם נסיעה מתאימה תבוטל, תקבל/י הודעה.",
    preferredCar: "רכב מועדף (לא חובה)",
    noPreferredCar: "ללא העדפה",
    preferredCarHelper: "ננסה לשבץ את הרכב שבחרת. אם לא יתאפשר, אפשר לשבץ רכב אחר.",
    preferredCarUnavailable: "הרכב שנבחר אינו זמין — בחרו רכב אחר או ללא העדפה",
    rideTypeRequired: "יש לבחור סוג נסיעה",
    destinationRequired: "יש לבחור או להזין יעד",
    validationSummary: "יש להשלים או לתקן את השדות המסומנים",
    editWindowClosed: "הבקשות לשבוע הזה נסגרו והסידור עוד לא פורסם — לשינוי פנה/י לסדרן/ית",
    luggageLabel: "ציוד רב — צריך תא מטען גדול",
    luggageHint: "למשל קניות גדולות, ציוד, ריהוט (איקאה). נבחר לך רכב עם תא מטען גדול.",
    acceptedWaitingOthers: "אישרת — ממתין לאחרים",
    luggageChip: "ציוד גדול",
    overlapTitle: "כבר יש לך נסיעה או בקשה בשעות האלה",
    overlapBody: "אפשר לבטל את הקודמת ולהגיש את החדשה, להשאיר את שתיהן, או לחזור לעריכה.",
    overlapCancelOther: "בטל/י את הקודמת והגש/י",
    overlapKeepBoth: "השאר/י את שתיהן",
    overlapBack: "חזרה",
    /** The overlap dialog names the other request ("חיפה · ד׳ 13.10 07:30–12:00"); a multi-day one cannot be cancelled from here. */
    overlapOther: "הבקשה החופפת: {{name}}",
    overlapSeriesBody: "הבקשה החופפת היא חלק מבקשה רב-יומית ({{count}} ימים), ואי אפשר לבטל אותה מכאן. אפשר להשאיר את שתיהן או לחזור לעריכה.",
    noChanges: "לא בוצעו שינויים",
    releaseTitle: "אין רכב פנוי בשעות החדשות",
    releaseBody: "אין רכב פנוי בשעות החדשות — הנסיעה הנוכחית תשוחרר והבקשה תעבור לרשימת ההמתנה. להמשיך?",
    releaseDrivesOthers: "הנוסעים בנסיעה שלך יישארו בה וימתינו לנהג/ת",
    releaseKeepPassengersTitle: "הנוסעים שלך יישארו בלי נהג/ת",
    releaseKeepPassengersBody: "יש רכב פנוי בשעות החדשות, אבל הנוסעים בנסיעה הנוכחית שלך יישארו בה וימתינו לנהג/ת. להמשיך?",
    overlapRefused: "הבקשה חופפת לנסיעה או לבקשה אחרת שלך ולכן לא שובצה אוטומטית — הסדרן/ית יבדוק",
    overlapRefusedNamed: "הבקשה חופפת ל{{names}} ולכן לא שובצה אוטומטית — הסדרן/ית יבדוק",
    loseBookingTitle: "השינוי יוריד אותך מהרכב",
    loseBookingBody: "אם תשמור/י את השינוי הבקשה תחזור להמתנה והרכב שנשמר לך ישוחרר. להמשיך?",
    childOverlapTitle: "ילד/ה כבר בבקשה אחרת",
    childOverlap: "{{child}} כבר בבקשה של {{name}} ({{time}}) — להגיש בכל זאת?",
    childOverlapConfirm: "להגיש בכל זאת",
    placeOnOwnCar: "לשים על הרכב הפרטי שלי",
    placeOnOwnCarTitle: "על איזה רכב פרטי?",
    placedOnOwnCar: "הבקשה הועברה לרכב הפרטי שלך",
    notDuplicate: "זו לא כפילות — אני צריך/ה את שתיהן",
    notDuplicateRestored: "הבקשה שוחזרה",
    notFound: "הבקשה לא נמצאה",
    flexBoth: "מוקדם או מאוחר (±)",
    flexLater: "מאוחר בלבד (+)",
    flexEarlier: "מוקדם בלבד (−)",
    flexDirection: "כיוון הגמישות",
    tripShapeRoundTrip: "הלוך ושוב",
    tripShapeOneWayTo: "הלוך בלבד",
    tripShapeOneWayFrom: "חזור בלבד",
    // REQ §13.93: the three trip types shown in the request form, replacing
    // TripShapeControl/CarAtDestinationToggle (step O5a).
    tripTypeRoundTrip: "הלוך-חזור",
    tripTypeOneWay: "הלוך בלבד",
    tripTypeDropOff: "הקפצה",
    /** Origin line above the destination field, tap to change (REQ §13.93). */
    fromOrigin: "מ{{place}} אל",
    /** "+ עצירה" — opens the out-stop picker inline (REQ §13.93 "Multi-stop rides"). */
    addStop: "+ עצירה",
    stopPlaceholder: "איפה עוצרים?",
    /** "+ עצירה בחזור" — same, for the return leg, shown only when the trip has a return. */
    addReturnStop: "+ עצירה בחזור",
    /** Remove-stop chip button `aria-label`. */
    removeStop: "הסרת עצירה",
    /** "הקפצה" optional pickup leg toggle. */
    dropOffPickupToggle: "צריך/ה גם איסוף",
    /** Shown when a non-driver member has not named a driving companion (REQ §13.88/§13.93). */
    nonDriverTripTypeHint: "בלי מלווה/ת שנוהג/ת, אפשר להגיש רק בקשת הקפצה",
    departArrival: "הגעה הביתה",
    carAtDestinationHelper:
      "אם תכבו: הרכב יחזור לקיבוץ ויוכל לשמש אחרים. ייתכן שתיסע/י כנוסע/ת אצל מישהו, או שתנהג/י ותשאיר/י את הרכב שם למי שחוזר/ת.",
    returnNextDay: "למחרת",
    flexibilityHelper: "גמישות מעלה את הסיכוי לקבל רכב",
    weekEndBlockingError: "נסיעה שמסתיימת אחרי שבת — פנה/י לסדרן/ית",
    returnBeforeDeparture: "שעת החזרה חייבת להיות אחרי שעת היציאה",
    seatFitWarning: "הרכבים במחלקה לא מתאימים למספר הנוסעים שביקשת; הסדרן/ית יטפלו בכך.",
    duplicateWarning: "יש לך כבר בקשה חופפת בזמנים האלה — אולי כדאי לערוך אותה במקום לפתוח בקשה חדשה.",
    editRequestLink: "לעריכת הבקשה",
    changedSinceSolveBanner: "השבוע כבר בהכנה — השינוי יסומן לסדרן/ית",
    joinRideBannerShared: "בקשה להצטרף לנסיעה של {{driverName}} — הסדרן/ית יציעו לו/לה את האיחוד",
    joinRideBannerTemp:
      "בקשה להצטרף לנסיעה של {{driverName}} ברכב הפרטי שלו/שלה — ההצעה תישלח אליו/אליה ישירות",
    withdrawConfirmTitle: "להסיר את הבקשה?",
    withdrawConfirmBody: "הבקשה תוסר ולא תישלח לסדרן/ית.",
    /** R10U7: removing / cancelling a request that is already served by its plan B (REQ §13.112 a) — it is placed, not unsent. */
    withdrawPlanBBody: "הבקשה כבר שובצה בתוכנית ב׳. הסרתה מבטלת את ההקפצה שנקבעה.",
    withdrawPlanBPickupBody: "הבקשה כבר שובצה בתוכנית ב׳. הסרתה מבטלת את ההקפצה שנקבעה וגם את בקשת האיסוף הקשורה אליה.",
    cancelConfirmTitle: "לבטל את הנסיעה?",
    cancelConfirmBodyFreed: "הרכב יוצע לחברים ברשימת ההמתנה.",
    cancelConfirmBodyRelay: "הסדרן/ית יקבלו הודעה — הרכב צריך לחזור הביתה.",
    submitError: "לא ניתן היה לשלוח את הבקשה",
    repeatWeekly: "בקשה חוזרת (כל שבוע)",
    repeatWeeklyHint: "נציע לך את הבקשה הזאת בכל שבוע שנפתח; ההגשה עצמה נשארת בידיך",
    repeatSaved: "הבקשה תוצע לך גם בשבועות הבאים",
    /** R9M3: confirmation when the server's own outcome toast stays silent. */
    submitSent: "הבקשה נשלחה לסדרן/ית",
    submitSaved: "השינויים נשמרו",
    /** R9M1/R9B1: adults without a name (classic form stepper). */
    extraAdultsLabel: "מבוגרים נוספים (בלי שם)",
    extraAdultsMore: "עוד מבוגר/ת",
    extraAdultsLess: "פחות מבוגרים",
    /** R9B2: `/requests/:id/edit` of a multi-day request. */
    seriesPanelTitle: "בקשה רב-יומית · {{from}}–{{to}}",
    seriesPanelBody: "בקשה רב-יומית לא נערכת — אפשר רק לקצר אותה או לבטל אותה.",
    suggestionsTitle: "בקשות חוזרות לשבוע שנפתח",
    useSuggestion: "הגש/י",
    snoozeSuggestion: "לא השבוע",
    snoozed: "נדחה לשבוע הבא",
    stopSuggestion: "הפסק/י לחזור",
    stopSuggestionConfirmTitle: "להפסיק לחזור על הבקשה הזו?",
    stopSuggestionConfirmBody: "לא נציע לך יותר את הבקשה הזו בשבועות הבאים. אפשר להתחיל לחזור עליה מחדש מבקשה חדשה.",
    stopped: "הבקשה החוזרת הופסקה",
    makeRepeating: "הפוך/י לחוזר",
    repeating: "חוזר כל שבוע",
    /**
     * Multi-day requests ("series", REQ §13.77, UX_FLOWS.md §3.4/§3.3, built 2026-09-10):
     * the return-day picker (new mode, weekly variant, round trip only), the resulting
     * span's hint/confirmation and outcome toasts, and the "one card per series" list.
     */
    // "תאריך" rather than "יום" deliberately: the ordinary departure-day picker's own
    // radiogroup is already labelled "יום" (`he.field.day`) — Playwright's `getByRole`
    // matches accessible names by substring by default, so a label containing "יום" here
    // would make e2e's plain `radiogroup name: "יום"` selectors (auto-approve.spec.ts,
    // member.spec.ts, quick-request.spec.ts) resolve to two elements once this second
    // radiogroup renders (weekly + new mode + round trip).
    returnDay: "תאריך החזרה",
    returnAnotherDay: "חזרה ביום אחר?",
    returnSameDay: "חזרה באותו יום",
    multiDayHint: "הרכב שמור לך מהיציאה ועד החזרה, כולל הלילות. כל הימים באותו רכב.",
    multiDayLongTitle: "לשמור רכב ליותר משבוע?",
    multiDayLongBody: "הבקשה תופסת רכב משותף ל{{days}} ימים. להמשיך?",
    seriesAssigned: "הרכב שמור לך לכל הימים",
    seriesWaitlisted: "אין רכב פנוי לכל הימים — נכנסת לרשימת ההמתנה",
    multiDayBadge: "{{count}} ימים",
    seriesCancelBody: "הביטול חל על כל ימי הבקשה הרב-יומית.",
    stopEqualsOrigin: "העצירה זהה למקום היציאה",
    stopEqualsDestination: "העצירה זהה ליעד",
    originEqualsDestination: "מקום היציאה והיעד זהים",
    shortenSeries: "קיצור הבקשה",
    shortenSeriesTitle: "קיצור הבקשה הרב-יומית",
    shortenSeriesHelp: "בחרו יום ושעת יציאה חדשים, ויום ושעת חזרה חדשים בתוך הימים של הבקשה. הימים שיוצאים מהטווח משתחררים, והרכב נשמר לימים שנשארו.",
    shortenFirstDay: "יום יציאה חדש",
    shortenLastDay: "יום חזרה חדש",
    shortenDepartTime: "שעת יציאה",
    shortenReturnTime: "שעת חזרה",
    shortenSubmit: "קיצור",
    shortenInvalidRange: "יום הסיום לא יכול להיות לפני יום ההתחלה, והחזרה צריכה להיות אחרי היציאה",
    shortenUnchanged: "הטווח לא השתנה",
    shortenDone: "הבקשה קוצרה",
  },
  requestsList: {
    withdrawAll: "הסר את כל הבקשות",
    withdrawAllTitle: "להסיר את כל הבקשות לשבוע הזה?",
    withdrawAllBody: "כל הבקשות שלך במחלקה ובשבוע הזה יוסרו, כולל שיבוצים שטרם פורסמו. אפשר להגיש בקשות חדשות עד סגירת החלון.",
    title: "הבקשות שלי",
    empty: "אין לך בקשות עדיין.",
    groupLabel: "שבוע {{weekLabel}}",
    edit: "ערוך",
    withdraw: "הסר בקשה",
    cancelRide: "בטל נסיעה",
    stillWantIt: "אני עדיין רוצה",
    withdrawClaim: "בטל בקשת הצטרפות",
    freedSlotOffer: "התפנה רכב — {{car}}, {{day}} {{depart}}–{{return}}",
  },
  siddur: {
    myRide: "הנסיעה שלי",
    filterDestination: "יעד",
    filterEmpty: "אין נסיעות ל{{destination}} השבוע.",
    filterEmptyAction: "פתח/י בקשה ל{{destination}}",
    notPublishedYet: "הסידור לשבוע {{weekLabel}} עדיין לא פורסם. בינתיים אפשר לראות את הבקשות שלך.",
    notPublishedAction: "לבקשות שלי",
    freeSeats: "{{count}} מקומות פנויים",
    relayChip: "העברת רכב",
    temporaryChip: "רכב פרטי",
    otherDeptNote: "מחלקה אחרת — לצפייה בלבד",
    departmentSwitcher: "מחלקה",
    dayCount: "{{count}}",
    gridView: "תצוגת לוח",
    listView: "תצוגת רשימה",
    noRides: "אין נסיעות ביום הזה.",
    thisWeek: "השבוע",
    nextWeek: "שבוע הבא",
    waitlistForDay: "רשימת המתנה ליום {{day}}",
    displayMenu: "תצוגה",
    archive: "ארכיון",
    archiveTitle: "ארכיון סידורים",
    archiveEmpty: "אין עדיין סידורים בארכיון",
    archivedWeekHint: "סידור מהארכיון (לצפייה בלבד)",
  },
  // REQ §13.108 f: "be back on time" — who takes the car next / where it arrives from (display only).
  carHandover: {
    alertLabel: "שימו לב",
    returnByRide: "{{name}} לוקח/ת את הרכב ב-{{time}} — חשוב להחזיר בזמן",
    returnByUnnamed: "הרכב נלקח ב-{{time}} — חשוב להחזיר בזמן",
    returnByReservation: "הרכב שמור ב-{{time}} — חשוב להחזיר בזמן",
    returnByCarMove: "הרכב מועבר ב-{{time}} — חשוב להחזיר בזמן",
    arrivesFromRide: "הרכב מגיע מהנסיעה של {{name}} ב-{{time}}, ממש לפני הנסיעה שלך",
    arrivesFromUnnamed: "הרכב מגיע מנסיעה קודמת ב-{{time}}, ממש לפני הנסיעה שלך",
    arrivesFromReservation: "הרכב מגיע משמירת זמן ב-{{time}}, ממש לפני הנסיעה שלך",
    arrivesFromCarMove: "הרכב מועבר אליך ב-{{time}}, ממש לפני הנסיעה שלך",
  },
  rideDetail: {
    title: "פרטי הנסיעה",
    driver: "נהג/ת",
    chauffeur: "הסעה · מסיע/ה",
    passengers: "נוסעים",
    car: "רכב",
    carModeKeep: "הרכב נשאר איתי ביעד",
    carModeRelayOut: "הרכב נשאר ב{{destination}}",
    carModeRelayBack: "הרכב נאסף מ{{origin}}",
    carModeChauffeur: "הנהג/ת חוזר/ת עם הרכב",
    askToJoin: "בקש/י להצטרף",
    askToJoinConfirmShared: "בקשת ההצטרפות תישלח לסדרן/ית, שיהפכו אותה להצעת איחוד לנהג/ת.",
    askToJoinConfirmTemp: "בקשת ההצטרפות תישלח ישירות לבעל/ת הרכב הפרטי.",
    locationBadge: "ב{{location}}",
    /** Multi-day request leg (REQ §13.77, UX_FLOWS.md §3.5). */
    seriesLine: "חלק מבקשה רב-יומית, יום {{index}} מתוך {{count}}",
    /** REQUIREMENTS §13.93 "Multi-stop rides" Display: the ride sheet/ride-detail route-with-stops section. */
    routeStopsTitle: "עצירות בדרך",
    routeStopsOut: "הלוך:",
    routeStopsReturn: "חזור:",
  },
  /** REQ §13.94: the ride's whole route (both legs, with estimated times) in the ride sheet/ride detail. */
  rideRoute: {
    title: "מסלול הנסיעה",
    out: "הלוך",
    return: "חזור",
    origin: "יציאה",
    destination: "יעד",
    stop: "עצירה",
    board: "עלייה: {{name}}",
    alight: "ירידה: {{name}}",
  },
  /**
   * The "+ נוסעים" button (siddur `RideDetailSheet` and the board's `RideSheet`, REQ §13.85):
   * anyone in the department may add named passengers to any published ride.
   * `add_ride_passengers()`/`remove_ride_passenger()`, 20260914170000_add_ride_passengers_rpc.sql.
   */
  addPassengers: {
    button: "+ נוסעים",
    title: "הוספת נוסעים לנסיעה",
    submit: "הוספה",
    added: "הנוסעים נוספו לנסיעה",
    removed: "הנוסע/ת הוסר/ה מהנסיעה",
    removeAriaLabel: "הסרת {{name}}",
    weekNotPublicHint: "אפשר להוסיף נוסעים רק לנסיעה מפורסמת",
    /** First checkbox in the dialog (owner decision 2026-09-14): the signed-in member joining
     * the ride themself — replaces the siddur's old "ask to join" button on a published week. */
    self: "אני",
    selfAlreadyOn: "כבר רשומ/ה על הנסיעה הזו",
  },
  proposalScreen: {
    loading: "טוען הצעה…",
    notFound: "הקישור אינו תקין",
    expired: "ההצעה פקעה — הבקשה חזרה למצב הקודם",
    rateLimited: "יותר מדי בקשות, נסו שוב בעוד דקה",
    alreadyAnswered: "כבר עניתם להצעה הזו",
    genericError: "לא ניתן לטעון את ההצעה כרגע",
    confirmedTitle: "תודה! הסדרן/ית יעדכנו את הסידור",
    /** R10U9: after accepting a plan B on `/p/:token` — it was applied on the spot, unlike every other answer. */
    confirmedPlanBTitle: "ההצעה אושרה — שובצת בתוכנית ב׳",
    confirmedPlanBHelp: "אפשר לראות אותה ב״הנסיעות שלי״.",
    /** R11M3 (REQ §13.112 a): what a plan-B proposal states — the car, when it leaves and arrives, the pickup, and that accepting replaces the original request. */
    planB: {
      car: "רכב: {{car}}",
      leave: "יוצאים ב־{{depart}} מ{{origin}} · מגיעים ל{{place}} ב־{{arrive}}",
      leaveNoOrigin: "יוצאים ב־{{depart}} · מגיעים ל{{place}} ב־{{arrive}}",
      pickup: "איסוף ב־{{pickup}}",
      pickupFrom: "איסוף מ{{pickupPlace}} ב־{{pickup}}",
      pickupCar: "ברכב {{car}}",
      otherCar: "רכב אחר לאיסוף",
      back: "חזרה ב־{{back}}",
      replaces: "אם מאשרים, ההצעה מחליפה את הבקשה המקורית. במקום: {{original}}",
      originalTrip: "{{trip}} ל{{place}} {{times}}",
    },
    alreadyAnsweredBy: "התשובה שלך נרשמה",
    backHome: "לדף הבית",
    yourRequest: "הבקשה שלך",
    before: "המקורי",
    after: "המוצע",
    reason: "סיבה",
    validUntil: "ההצעה בתוקף עד {{time}}",
    detourNote: "תוספת של כ-{{detourMin}} דק'",
    driverRole: "כנהג/ת",
    passengerRole: "כנוסע/ת",
    optOutFreedSlots: "אל תציעו לי מקומות שמתפנים השבוע",
    recordedBy: "נרשם על ידי {{sadranName}} לפי תשובתך בוואטסאפ",
    contactSadranWhatsapp: "לדבר עם הסדרן/ית בוואטסאפ",
    contactSadranWhatsappMessage: "שלום, אני רוצה לשאול לגבי ההצעה שקיבלתי",
  },
  inboxExtra: {
    filterAll: "הכול",
    filterProposals: "הצעות",
    filterSiddur: "סידור",
    filterFreedSlot: "רכב פנוי",
    filterSystem: "מערכת",
    empty: "אין הודעות עדיין. כשהסידור יפורסם או תתקבל הצעה — זה יופיע כאן.",
    sadranChip: "סדרן",
  },
  profileExtra: {
    detailsTitle: "פרטים",
    email: "אימייל",
    displayName: "שם לתצוגה (כינוי / שם בעברית)",
    displayNameHelp: "השם יופיע באפליקציה. השאירו ריק כדי להשתמש בשם מחשבון Google.",
    departmentsTitle: "מחלקות",
    defaultBadge: "ברירת מחדל",
    homeWeekTitle: "מסך הבית",
    homeWeekLabel: "שבוע ברירת מחדל במסך הבית",
    homeWeekHelper: "הנסיעות הקרובות והבקשות שלא שובצו מוצגות תמיד למעלה, בלי קשר לבחירה.",
    homeWeekAuto: "אוטומטי",
    homeWeekLive: "השבוע הפעיל",
    homeWeekOpen: "השבוע הפתוח",
    /** "נקודת יציאה קבועה" card (REQ §13.93): per-department default origin, `set_my_default_origin`. */
    defaultOriginTitle: "נקודת יציאה קבועה",
    defaultOriginLabel: "נקודת יציאה",
    defaultOriginHelp: "נקודת היציאה שתוצע כברירת מחדל בבקשות חדשות במחלקה הזו.",
    defaultOriginHome: "בית (ברירת מחדל)",
    defaultOriginNoDepartment: "יש לבחור מחלקה כדי להגדיר נקודת יציאה",
    notificationsTitle: "התראות",
    pushEnabled: "מופעל",
    pushDisabled: "כבוי",
    pushEnable: "הפעל התראות",
    pushDisable: "כבה התראות",
    muteWindow: "תזכורות על חלון בקשות",
    muteSiddur: "פרסום הסידור",
    muteProposals: "הצעות",
    muteFreedSlots: "מקומות שמתפנים",
    muteMaintenance: "תקלות ותחזוקה",
    sadranEventsNote: "לא ניתן להשתקה כל עוד את/ה סדרן/ית",
    tempCarTitle: "רכב פרטי לשיתוף",
    tempCarNickname: "כינוי הרכב",
    tempCarPlate: "מספר רישוי",
    tempCarSeats: "תצורת מושבים",
    tempCarActiveUntil: "פעיל עד",
    tempCarNone: "עדיין לא נרשם רכב פרטי.",
    tempCarRevoked: "הוצא משימוש על ידי המנהל/ת",
    /** REQ §88 (owner 2026-09-15): a member marks themselves as never driving; the solver
     * and Sadran then place them only as a passenger/chauffeur, never as a driver. */
    doesNotDriveLabel: "אני לא נוהג/ת",
    doesNotDriveHelp: "לא אשובץ/אשובץ כנהג/ת; אפשר להביא נהג/ת אורח/ת",
    /** REQ §13.110 (e): the member's choice of the old field-by-field request form. */
    classicRequestFormLabel: "טופס הבקשה הקלאסי",
    classicRequestFormHelp: "הטופס הישן, שדה אחרי שדה",
    historyLink: "היסטוריה וסטטיסטיקה",
    managementTitle: "ניהול",
    themeTitle: "מראה",
    themeLabel: "ערכת צבעים",
    themeLight: "בהיר",
    themeDark: "כהה",
    themeSystem: "לפי המכשיר",
    /** Version footer label (docs/RUNBOOK_ROLLBACK.md); the release tag/short commit itself is rendered separately, `dir="ltr"`. */
    version: "גרסה",
  },
  freedSlot: {
    title: "רכב שהתפנה",
    body: "{{car}}, {{day}} {{depart}}–{{return}}. עדיין רלוונטי?",
    withdrawClaimTitle: "לבטל את בקשת ההצטרפות?",
    withdrawClaimBody: "הבקשה שלך לרכב שהתפנה תבוטל.",
  },
  /**
   * `/my/history` (REQ §13 item 91, owner 2026-09-16, E3): a small, lazily loaded, read-only
   * list of past requests/rides — reachable only from a link at the bottom of `/my`, "not
   * important, must not slow anything" (owner A4).
   */
  myHistory: {
    link: "היסטוריה",
    title: "היסטוריה",
    empty: "אין עדיין היסטוריה.",
  },
  quickRequest: {
    oneWayHeader: "בקשת הסעה ביום {{day}} {{start}}",
    submitOneWay: "הוסף/י הסעה שמחפשת נהג/ת",
    rideDescription: "תיאור הנסיעה",
    rideDescriptionHelp: "מוצג לכל מי שצופה בנסיעה. אפשר לתאר את המסלול והאיסופים.",
    guestPassengers: "נוסעים שאינם ברשימת החברים",
    guestPassengersHelp: "שם אחד בכל שורה. שמות הנוסעים מוצגים עם הנסיעה.",
    invalidGuestNames: "אפשר להוסיף עד 20 שמות אורחים, עד 100 תווים לכל שם.",
    oneWayHelp: "הרכב יישמר להסעה ויופיע באדום עד שמישהו יתנדב לנהוג. נשמר גם מקום נוסף לנהג/ת.",
    arrivalHomeHelp: "השעה היא שעת ההגעה הביתה. הרכב יוצא לאיסוף מוקדם יותר.",
    vehicleWindow: "הרכב נדרש בשעות ⁦{{start}}–{{end}}⁩, כולל נסיעת הנהג/ת והאיסוף.",
    submitOneWayTakeCar: "קח/י את הרכב (הלוך בלבד)",
    successOneWayAssigned: "{{car}} שלך ב-{{start}} — הלוך בלבד, הרכב יישאר ביעד",
    successNeedsDriver: "{{car}} נשמר להסעה — עדיין דרוש/ה נהג/ת",
    header: "לוקח/ת את {{car}} ביום {{day}} {{start}}",
    headerNoCar: "לוקח/ת רכב ביום {{day}} {{start}}",
    submit: "קח/י את הרכב",
    takeCarNow: "רוצה רכב עכשיו!",
    noCarNow: "אין רכב פנוי עכשיו",
    notesExpand: "הוספת הערה לסדרן/ית",
    pastSlotTooltip: "אי אפשר לבחור זמן שכבר עבר",
    overlapWarning: "הרכב הזה תפוס (או קרוב מדי לנסיעה אחרת) בשעות האלה",
    overlapOfferOtherCar: "רכב אחר פנוי — {{car}}",
    awayWarning: "הרכב לא נמצא בבית בשעה הזו",
    noCarFree: "אין רכב פנוי כרגע לשעות האלה",
    successAssigned: "הרכב שלך ✓ {{car}} ⁦{{start}}–{{end}}⁩",
    successFallback: "{{car}} שובץ במקום — {{preferredCar}} היה תפוס באותה שעה",
    successCarWasFree: "התפנה רכב ({{car}}) — הבקשה שובצה, אין צורך ברשימת ההמתנה",
    waitlisted: "אין רכב פנוי כרגע — הבקשה שלך נכנסה לרשימת ההמתנה",
    waitlistedLink: "לבקשות שלי",
    submitError: "לא ניתן היה לשלוח את הבקשה",
    freeGapRow: "פנוי ⁦{{start}}–{{end}}⁩",
    carPickerLabel: "רכב",
    nextFreeAt: "פנוי מ-{{time}}",
    homeCardSubtitle: "{{car}} פנוי עכשיו",
    /** `RequestForm` `variant="carNow"` duration-hours select (UX_FLOWS.md §18/Home §3.3). */
    durationHours: "לכמה שעות?",
    hoursOption: "{{n}} שעות",
    hoursOptionOne: "שעה אחת",
  },
  /**
   * REQ §13.112 (a)/(b): "אם אין רכב…" — plan B ("תוכנית ב׳": a הקפצה to a drop point, optionally with a pickup from the
   * same place) or "אסתדר" on a הלוך-חזור / הלוך בלבד request. Form line (`PlanBLine`), stage-2 recap, `/my` lines.
   */
  planB: {
    /** The link under the sentence that adds the line. */
    link: "+ אם אין רכב…",
    prefix: "אם אין רכב,",
    kind: { alternative: "הקפצה", manage: "אסתדר" },
    /** Glue before the drop place chip ("ל" + chip), "עד" before the arrival chip, then the pickup words. */
    toPrefix: "ל",
    untilPrefix: "עד",
    pickupWords: "ואיסוף",
    pickupFromPrefix: "מ",
    /** The pickup place chip while it is the drop place itself. */
    samePlaceChip: "משם",
    atPrefix: "ב־",
    noPickupChip: "בלי איסוף",
    placeEmpty: "בחר/י נקודה",
    sheet: {
      kind: "אם אין רכב",
      place: "להקפיץ אותי אל",
      arrive: "להיות שם עד",
      /** The arrive sheet's title once the drop place is known / before it is chosen (R10U5). */
      arriveAt: "להיות ב{{place}} עד",
      arriveNoPlace: "להיות ב[נקודת ההקפצה] עד",
      pickup: "איסוף משם ב־",
      pickupFromAt: "איסוף מ{{place}} ב־",
      pickupNoPlace: "איסוף מ[נקודת ההקפצה] ב־",
      pickupPlace: "מאיפה לאסוף?",
      /** Shown in the arrive sheet when the drop time pushed the pickup along (R10U4). */
      pickupMoved: "גם האיסוף זז ל־{{time}}",
      /** The estimate line while the drop place (so the drive) is not known yet (R10U5). */
      estimateUnknown: "יציאה משוערת —",
    },
    /** The classic form's "+ תוכנית ב׳" section (R10M1). */
    classic: {
      link: "+ תוכנית ב׳",
      title: "תוכנית ב׳",
      kind: "מה אם אין רכב?",
      place: "להקפיץ אותי אל",
      arrive: "להיות שם עד",
      pickupSwitch: "ואיסוף משם",
      pickupPlace: "מאיפה לאסוף? (ברירת מחדל: מאותו מקום)",
      pickupPlaceSame: "מאותו מקום",
      pickupAt: "שעת איסוף",
    },
    /** Switching the main trip to a הקפצה (R10M2): uses plan B, or asks for it as one sentence. */
    switch: {
      title: "מעבר להקפצה",
      instead: "במקום {{trip}}, הקפצה",
      toPlace: "ל…",
      untilTime: "עד",
      pickupSwitch: "ואיסוף",
      pickupFromPlace: "מ…",
      pickupFromPlaceHint: "ללא בחירה: מאותו מקום",
      atTime: "ב־",
      confirm: "מעבר להקפצה",
      /** Toast: the main form picks up from the drop place only; the other pickup place stays in plan B. */
      pickupPlaceKept: "הקפצה ל{{place}} — האיסוף יהיה מ{{place}}. האיסוף מ{{pickupPlace}} נשמר, וחוזר כשחוזרים להלוך-חזור.",
    },
    options: {
      alternative: "הקפצה",
      alternativeHint: "תוכנית ב׳: מקפיצים אותי לנקודה, ואפשר גם לאסוף משם",
      manage: "אסתדר",
      manageHint: "אין לי פתרון חלופי — אם אין רכב, אסתדר",
      none: "בלי",
      noneHint: "מסירים את השורה",
    },
    placeSearch: "חיפוש נקודת הקפצה",
    samePlaceOption: "אותו מקום (משם)",
    dropPointTag: "נקודת הקפצה",
    pickupToggle: "בלי איסוף",
    pickupToggleOn: "עם איסוף משם",
    error: {
      placeRequired: "בחר/י לאן להקפיץ",
      arriveRequired: "בחר/י עד איזו שעה להיות שם",
      pickupRequired: "בחר/י שעת איסוף או בטל/י את האיסוף",
      pickupBeforeArrive: "האיסוף צריך להיות אחרי ההגעה",
      sameAsOrigin: "נקודת ההקפצה זהה למקום היציאה",
      pickupSameAsOrigin: "מקום האיסוף זהה למקום היציאה",
    },
    /** Stage-2 recap and `/my`: the plan B of a request that still waits for a car. */
    recap: "אם אין רכב: הקפצה ל{{place}} עד {{arrive}} ואיסוף משם ב־{{pickup}}",
    /** Twin of the SQL fragment `alt.pickup_from` (", ואיסוף מ{{pickupPlace}} ב־{{pickupTime}}") — keep the wording identical. */
    recapPickupFrom: "אם אין רכב: הקפצה ל{{place}} עד {{arrive}}, ואיסוף מ{{pickupPlace}} ב־{{pickup}}",
    recapNoPickup: "אם אין רכב: הקפצה ל{{place}} עד {{arrive}}",
    recapManage: "אם אין רכב: אסתדר",
    myLine: "תוכנית ב׳: הקפצה ל{{place}} עד {{arrive}} · איסוף ב־{{pickup}}",
    myLinePickupFrom: "תוכנית ב׳: הקפצה ל{{place}} עד {{arrive}} · איסוף מ{{pickupPlace}} ב־{{pickup}}",
    myLineNoPickup: "תוכנית ב׳: הקפצה ל{{place}} עד {{arrive}}",
    myLineManage: "אם אין רכב: אסתדר",
    /** `/my`: a request served by its plan B. */
    served: "שובצת בתוכנית ב׳: הקפצה ל{{place}} עד {{arrive}}, איסוף מ{{pickupPlace}} ב־{{pickup}}",
    servedNoPickup: "שובצת בתוכנית ב׳: הקפצה ל{{place}} עד {{arrive}}",
    original: "הבקשה המקורית: {{route}} {{day}} {{times}}",
    originalRoute: "{{trip}} ל{{destination}}",
  },
  /**
   * REQ §13.110 / UX_FLOWS §3.4a: the sentence layout of `RequestForm` (`features/requests/
   * components/requestForm/sentence/`). Sentence glue is split so the chips can sit inside the
   * prefix letters ("מ" + chip, "ל" + chip); anchor labels are keyed by `anchorLabelKey()`.
   */
  requestSentence: {
    hint: "אפשר ללחוץ על כל מילה מודגשת",
    hintDismiss: "הבנתי",
    /** The who chip's own label ("אני"); more names follow it (`joinNames`). */
    me: "אני",
    needs: "צריך/ה",
    needsPlural: "צריכים",
    from: "מ",
    to: "ל",
    on: "ב",
    via: "דרך",
    /** Stage-2 recap: the stops of the return leg. */
    recapReturnVia: "בחזור דרך {{names}}",
    and: "ו",
    /** The conjunction before a number: "ו־2 ילדים". */
    andNumber: "ו־",
    dayChip: "יום {{day}}",
    sheetDone: "אישור",
    sheetClose: "סגירה",
    sheet: {
      trip: "סוג הנסיעה",
      origin: "מאיפה?",
      destination: "לאן?",
      stop: "עצירה בדרך",
      returnStop: "עצירה בדרך חזרה",
      day: "באיזה יום?",
      outTime: "מתי יוצאים?",
      returnTime: "מתי חוזרים?",
      pickupTime: "מתי האיסוף?",
      duration: "לכמה זמן?",
      who: "מי נוסע?",
    },
    recentDestinations: "יעדים אחרונים",
    anchorToggle: "איך מציינים את השעה",
    anchor: {
      outLeave: "לצאת ב־",
      outArrive: "להגיע עד",
      returnArrive: "להיות בבית עד",
      returnLeave: "לצאת משם ב־",
      pickupLeave: "איסוף משם ב־",
      pickupArrive: "איסוף, בבית עד",
    },
    estimate: {
      departEstimate: "יציאה משוערת {{time}} · {{minutes}} דק׳ נסיעה",
      arriveEstimate: "הגעה משוערת {{time}} · {{minutes}} דק׳ נסיעה",
      homeEstimate: "בבית בערך {{time}} · {{minutes}} דק׳ נסיעה",
      leaveEstimate: "יציאה משם בערך {{time}} · {{minutes}} דק׳ נסיעה",
    },
    flexRowLabel: "± גמישות",
    flexChip: {
      "0": "בדיוק",
      "15": "¼ ש׳",
      "30": "½ ש׳",
      "60": "שעה",
      "120": "שעתיים",
      any: "כל היום",
    },
    /** Brief flexibility on the sentence chip: "· ±½ ש׳". */
    flexBrief: "±{{amount}}",
    flexBriefSplit: "גמישות",
    /** Asymmetric flexibility on the chip: "· ½ ש׳ מוקדם / ¼ ש׳ מאוחר". */
    flexBriefEarly: "{{amount}} מוקדם",
    flexBriefLate: "{{amount}} מאוחר",
    flexSplitLink: "מוקדם ומאוחר בנפרד",
    flexSameLink: "אותו דבר לשני הצדדים",
    flexEarlier: "מוקדם יותר",
    flexLater: "מאוחר יותר",
    whoAddMember: "+ חבר/ה",
    whoExtraAdults: "+ מבוגר/ת (בלי שם)",
    whoExtraAdultsMore: "עוד מבוגר/ת",
    whoExtraAdultsLess: "פחות מבוגרים",
    /** The who chip's tail: "אני ועוד 2 מבוגרים", "אני, דנה ועוד מבוגר/ת". */
    whoMoreOne: "עוד מבוגר/ת",
    whoMoreMany: "עוד {{n}} מבוגרים",
    /** Unnamed children (REQ §13.112 d): "+ ילד/ה" with a seat type each; the who chip's tail ("אני ועוד ילד/ה", "אני, דנה ו־2 ילדים"). */
    whoUnnamedChildren: "+ ילד/ה (בלי שם)",
    whoChildSeats: "מושב בטיחות",
    whoBoosters: "בוסטר",
    whoChildSeatsMore: "עוד מושב בטיחות",
    whoChildSeatsLess: "פחות מושבי בטיחות",
    whoBoostersMore: "עוד בוסטר",
    whoBoostersLess: "פחות בוסטרים",
    whoMoreChildOne: "עוד ילד/ה",
    whoChildOne: "ילד/ה",
    whoChildMany: "{{n}} ילדים",
    whoAddGuest: "+ אורח/ת",
    whoMemberSearch: "חיפוש חבר/ה או ילד/ה",
    whoGuestPlaceholder: "שם האורח/ת",
    whoGuestAdd: "הוספה",
    whoNoMembers: "לא נמצאו חברים",
    /** Unit after the travel minutes next to a place in the place sheets (replaces the zone code). */
    minutesUnit: "דק׳",
    placeSearch: "חיפוש מקום",
    placeFreeText: "\"{{text}}\" — מקום חופשי",
    next: "המשך",
    stageBack: "חזרה לשלב הקודם",
    recapEdit: "עריכת הבקשה",
    description: "תיאור לכולם",
    note: "הערות לעיני הסדרן בלבד",
    empty: "—",
    rideType: "סוג נסיעה",
    car: "רכב",
    carAny: "לא משנה",
    carLuggage: "צריך/ה תא מטען גדול",
    carSpecific: "רכב מסוים",
    carPick: "בחר/י רכב",
    carRequired: "יש לבחור רכב",
    tripDropOffPickup: "הקפצה + איסוף",
    /** Outbound time sheet: the return moved with the departure. */
    returnMoved: "גם החזרה זזה ל־{{time}}",
    /** Stage-2 recap: anchored times carry their meaning. */
    recapLeave: "יציאה {{time}}",
    recapArriveBy: "להגיע עד {{time}}",
    recapHomeBy: "בבית עד {{time}}",
    recapLeaveThere: "יציאה משם {{time}}",
    recapPickupHomeBy: "איסוף, בבית עד {{time}}",
    recapPickupLeave: "איסוף משם {{time}}",
    carAlsoLuggage: "+ תא מטען גדול",
    carSummaryAny: "רכב לא משנה",
    carSummaryLuggage: "תא מטען גדול",
    carSummarySpecific: "רכב {{name}}",
    dayRange: "{{from}} עד {{to}}",
    destinationPlaceholder: "בחר/י יעד",
    carNowDuration: "לכמה זמן?",
    carNowHour: "שעה",
    carNowTwoHours: "שעתיים",
    carNowHours: "{{n}} ש׳",
    carNowMore: "עוד…",
    carNowReturnBy: "חזרה עד {{time}}",
    carNowMoreHours: "כמה שעות?",
    /** REQ §13.112 (c): "צריך/ה רכב ל[4 שעות] בין [07:00] ל־[12:00]" — N hours of car time in one block inside a window. */
    window: {
      link: "יש לי חלון זמן?",
      backToFixed: "שעות מסוימות",
      /** The prefix letters glued to the chips: "ל־4 שעות", "ל־12:00". */
      forPrefix: "ל־",
      between: "בין",
      hour: "שעה",
      twoHours: "שעתיים",
      hours: "{{n}} שעות",
      hoursTitle: "לכמה שעות צריך את הרכב?",
      startTitle: "מתי החלון מתחיל?",
      endTitle: "עד מתי החלון?",
      startAria: "תחילת החלון",
      endAria: "סוף החלון",
      more: "עוד…",
      hint: "הרכב יהיה אצלכם {{hours}} רצוף, בכל שעה בתוך החלון",
      tooShort: "החלון קצר מהזמן שצריך",
      required: "יש לבחור שעות וחלון זמן",
      /** `/my` row, board unmet card, request details: "4 שעות בין 07:00 ל־12:00". */
      summary: "{{hours}} בין {{start}} ל־{{end}}",
    },
    /** `/my` row + board unmet card: how the member entered a time (`enteredTimes.ts`). */
    enteredArriveBy: "להגיע עד {{time}}",
    enteredLeaveFrom: "יציאה מ{{place}} {{time}}",
    enteredPickupFrom: "איסוף מ{{place}} {{time}}",
  },
  memberErrors: {
    requestOutsideWeek: "הנסיעה יוצאת מגבולות השבוע — פנה/י לסדרן/ית",
    proposalExpired: "ההצעה פגה (למשל כי הסידור כבר פורסם). אפשר לפנות לסדרן/ית",
    proposalNotAnswerable: "ההצעה כבר נענתה או אינה זמינה",
    invalidToken: "הקישור אינו תקין",
    offerNotFound: "ההצעה לרכב שהתפנה לא נמצאה",
  },
  /**
   * Car report dialog (REQUIREMENTS §6.6, UX_FLOWS §3.9): three flows opened
   * from any car's name — report a problem, log a tire fill, log a wash.
   * `dialogTitle` doubles as the opening icon button's `aria-label`.
   */
  carCare: {
    dialogTitle: "דיווח על רכב {{car}}",
    close: "סגירה",
    homeProblemTitle: "דיווח על תקלה",
    homeTireFillTitle: "מילאתי אוויר בצמיגים",
    homeWashTitle: "שטפתי את הרכב",
    categoryLabel: "סוג התקלה",
    categoryRequired: "יש לבחור סוג תקלה",
    category: {
      warning_light: "אור אזהרה",
      mechanical: "תקלה מכנית",
      lighting: "תקלת תאורה",
      physical_damage: "נזק לרכב",
    },
    descriptionLabel: "פירוט התקלה",
    descriptionPlaceholder: "מה קרה?",
    descriptionRequired: "יש לפרט את התקלה",
    descriptionTooLong: "התיאור ארוך מדי (עד 500 תווים)",
    submitProblem: "שליחת דיווח",
    problemSuccessToast: "תודה, הדיווח נשלח לאחראי/ת הרכב",
    tirePosition: {
      front_left: "קדמי שמאל",
      front_right: "קדמי ימין",
      rear_left: "אחורי שמאל",
      rear_right: "אחורי ימין",
      spare: "גלגל רזרבי",
    },
    tireLegendOk: "תקין",
    tireLegendLow: "הוספתי 2–5 PSI",
    tireLegendVeryLow: "הוספתי מעל 5 PSI",
    tireNoteLabel: "הערה (לא חובה)",
    tireDone: "סיימתי",
    tireCelebration: "כל הכבוד על מילוי האוויר!",
    washButton: "שטפתי את הרכב",
    washCelebration: "הרכב נקי — תודה!",
  },
  /**
   * Car page (`/cars/:carId`, REQUIREMENTS §6.6, UX_FLOWS §5.11): the
   * responsible person's / admin's manage screen — details form, merged
   * issue/tire-fill/wash history with filters, and an Excel export. Reuses
   * `carCare.category.*`/`carCare.tirePosition.*` above for issue-category
   * and tire-position labels (no duplicate Hebrew) and
   * `adminIssues.statusOpen`/`statusResolved`/`unsafe` from `he.admin.ts`
   * for issue status (CLAUDE.md hard rule 3: one Hebrew string, one place).
   */
  carPage: {
    notAuthorized: "רק אחראי/ת הרכב או מנהל/ת מערכת יכולים לצפות בעמוד הזה",
    backHome: "חזרה לדף הבית",
    notFound: "הרכב לא נמצא",
    tabDetails: "פרטי הרכב",
    tabHistory: "היסטוריה",
    tabExport: "ייצוא",
    fieldResponsible: "אחראי/ת רכב",
    fieldResponsibleNone: "ללא אחראי/ת (הודעות יגיעו למנהלי המערכת)",
    fieldResponsibleReadonlyHelp: "רק מנהל/ת מערכת יכול/ה לשנות את האחראי/ת על הרכב",
    historyEmpty: "אין היסטוריה עדיין",
    historyFilterAll: "הכול",
    historyFilterIssue: "תקלות",
    historyFilterTireFill: "מילוי אוויר",
    historyFilterWash: "שטיפות",
    historyDateFrom: "מתאריך",
    historyDateTo: "עד תאריך",
    historyKindIssue: "תקלה",
    historyKindTireFill: "מילוי אוויר",
    historyKindWash: "שטיפה",
    historyReporter: "דיווח/ה",
    historyNote: "הערה",
    exportButton: "ייצוא לאקסל",
    exportLoading: "מכין קובץ…",
    exportIssuesSheet: "תקלות",
    exportTireFillsSheet: "מילוי אוויר",
    exportWashesSheet: "שטיפות",
    exportColumnDate: "תאריך ושעה",
    exportColumnReporter: "דיווח/ה",
    exportColumnCategory: "סוג התקלה",
    exportColumnDescription: "פירוט",
    exportColumnStatus: "סטטוס",
    exportColumnUnsafe: "לא בטוח לנסיעה",
    exportColumnNote: "הערה",
    exportColumnTireFrontLeft: "קדמי שמאל",
    exportColumnTireFrontRight: "קדמי ימין",
    exportColumnTireRearLeft: "אחורי שמאל",
    exportColumnTireRearRight: "אחורי ימין",
    exportColumnTireSpare: "גלגל רזרבי",
    exportTireStateOk: "תקין",
    exportTireStateLow: "נמוך",
    exportTireStateVeryLow: "נמוך מאוד",
    homeMyCarsTitle: "הרכבים באחריותי",
  },
  // Contested waiting-list groups (REQ §13.75, UX_FLOWS.md §3.5/§4.2 "בדיון"): the lane/card
  // label, the resolution sheet (`WaitlistGroupSheet`) and the "לדיון" action on a waitlisted
  // request whose `status_reason` is `WAITLISTED_CONTESTED`.
  waitlist: {
    laneTitle: "בדיון",
    blockLabel: "בדיון: {{names}}",
    sheetTitle: "מי נוסע/ת?",
    driver: "נהג/ת",
    seatsLine: "{{adults}} מבוגרים/ות · {{childSeats}} כיסאות בטיחות · {{boosters}} בוסטרים",
    summary: "{{count}} נוסעים/ות, {{seats}} מקומות",
    confirm: "אשר/י נסיעה משותפת",
    confirmBodySolo: "הנסיעה תירשם על שם {{driver}}. מי שלא סומן/ה נשאר/ת ברשימת ההמתנה.",
    confirmBody: "הנסיעה תירשם על שם {{driver}} עם {{names}}. מי שלא סומן/ה נשאר/ת ברשימת ההמתנה.",
    resolved: "הנסיעה נרשמה",
    readOnlyHint: "רק המשתתפים/ות או הסדרן/ית יכולים/ות להכריע",
    cancelGroup: "בטל/י את הדיון",
    cancelGroupBody: "כל המשתתפים/ות יישארו ברשימת ההמתנה.",
    openGroup: "לדיון",
  },
  /**
   * F4 (docs/TODO.md, owner answers A8-A10, 2026-09-14): after a waiting-list outcome
   * (published/live week), a second dialog offering existing rides that day going somewhere
   * close by, before the member just walks away to wait — `JoinableRidesDialog`
   * (`src/features/requests/components/`), shown by both `RequestForm` variants. The contact
   * channel is the existing "ask to join" flow; no phone numbers here (REQ §10).
   */
  joinableRides: {
    title: "נכנסת לרשימת ההמתנה — אבל יש אפשרות נוספת",
    body: 'יש נסיעות באותו יום ליעדים קרובים (עד {{radius}} ק"מ). אפשר להצטרף ישירות לאחת מהן:',
    distance: 'כ-{{km}} ק"מ מהיעד שלך',
    /** Joins the chosen ride directly (`add_ride_passengers()`) and withdraws the waitlisted
     * request — replaces the old "בקש/י להצטרף" (which navigated to a new request form),
     * owner decision 2026-09-14. */
    askToJoin: "הצטרפות לנסיעה",
    joined: "הצטרפת לנסיעה של {{driver}}",
    /** WhatsApp quick-link button (2026-09-14 owner amendment, REQ §10/§13.83): department phone numbers are not secrets. */
    whatsapp: "וואטסאפ",
    whatsappText: "היי {{driver}}, ראיתי שאת/ה נוסע/ת ל{{destination}} ביום {{day}} בשעה {{time}} — אפשר להצטרף לנסיעה?",
    stay: "להישאר ברשימת ההמתנה",
  },
  /**
   * Full-screen fallback rendered by the router's `errorElement` when a
   * route throws (`src/app/ErrorScreen.tsx`, CLAUDE.md hard rules 2/3,
   * docs/UX_FLOWS.md §2.3). Deliberately minimal: a title, one line of body
   * copy, a reload action and a link home; the raw error/stack goes in a
   * collapsed `<details>` for support, not translated.
   */
  errorScreen: {
    title: "משהו השתבש",
    body: "אירעה שגיאה בלתי צפויה. הנתונים שלך שמורים — אפשר לנסות שוב.",
    reload: "רענן/י",
    backHome: "לדף הבית",
    detailsSummary: "פרטים לתמיכה",
  },
} as const;

export type HeMemberDictionary = typeof heMember;
