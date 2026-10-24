/**
 * Tasks for the next user of a car (REQ item 150 b): the manager's request dialog and list on the car page, the
 * member's card on /my and the ride sheet, history and export labels. Own module (spread into `he.ts`) so the
 * concurrent car-administration work does not edit the same lines of `he.member.ts`.
 */
export const heCarTasks = {
  carTasks: {
    kind: {
      tire_fill: "למלא אוויר בצמיגים",
      wash: "לשטוף את הרכב",
      kilometrage: "לרשום את הקילומטראז׳",
      other: "אחר",
    },
    errors: {
      noteRequired: "יש לכתוב מה צריך לעשות",
      notOpen: "המשימה כבר לא פתוחה",
      notFound: "המשימה לא נמצאה",
    },
    // Member card (/my, ride sheet)
    cardTitle: "בקשה לפני הנסיעה ברכב {{car}}",
    cardHint: "מי שמשתמש/ת ברכב אחרי {{name}} מתבקש/ת:",
    requestedBy: "ביקש/ה {{name}}",
    actionTires: "מילאתי אוויר",
    actionWash: "שטפתי",
    actionKm: "רושם/ת קילומטראז׳",
    actionDone: "ביצעתי",
    doneToast: "תודה, סומן כבוצע",
    // Manager card (car page)
    manageTitle: "בקשות מהנוסע/ת הבא/ה",
    requestButton: "בקשה מהנוסע/ת הבא/ה",
    requestTitle: "בקשה מהנוסע/ת הבא/ה ברכב {{car}}",
    requestHelp: "מי שנוסע/ת ברכב בנסיעה הקרובה רואה את הבקשה רבע שעה לפני הנסיעה ועד רבע שעה אחרי שהיא נגמרת.",
    noteLabel: "מה צריך לעשות?",
    notePlaceholder: "למשל: להחזיר את המפתח לתיבה",
    requestSubmit: "שליחת הבקשה",
    requestSent: "הבקשה נשלחה",
    requestAlreadyOpen: "כבר יש בקשה פתוחה כזו",
    openEmpty: "אין בקשות פתוחות",
    askedBy: "בקשה של {{name}} · {{date}}",
    withdraw: "ביטול הבקשה",
    withdrawn: "הבקשה בוטלה",
    // History and export
    historyKind: "בקשה מהנוסע/ת הבא/ה",
    historyFilter: "בקשות",
    statusOpen: "ממתינה",
    statusDone: "בוצעה ע״י {{name}} · {{date}}",
    statusWithdrawn: "בוטלה · {{date}}",
    exportSheet: "בקשות מהנוסע הבא",
    exportColumnTask: "משימה",
    exportColumnStatus: "סטטוס",
    exportColumnDoneBy: "בוצע ע״י",
    exportColumnClosedAt: "תאריך ביצוע/ביטול",
    exportStatusOpen: "ממתינה",
    exportStatusDone: "בוצעה",
    exportStatusWithdrawn: "בוטלה",
  },
} as const;
