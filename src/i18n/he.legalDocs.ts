/**
 * The `/privacy` and `/terms` documents, Hebrew and English (`?lang=en`) — owner 2026-10-12, for Google's OAuth
 * requirements. Generic: an app for managing shared vehicles, never a specific community. Operator: Omri Glass
 * personally. Deliberately NOT merged into `he` (the eager bundle): only the lazily loaded `src/pages/LegalPage.tsx`
 * imports this file. `{{email}}` is replaced by `he.legal.contactEmail` (a mailto link). Not legal advice — the owner
 * reviews the wording; when it changes, change both languages and the "updated" dates.
 */

export interface LegalSection {
  heading: string;
  paragraphs: readonly string[];
}

export interface LegalDocument {
  title: string;
  updated: string;
  intro: string;
  sections: readonly LegalSection[];
}

const privacyHe: LegalDocument = {
  title: "מדיניות פרטיות",
  updated: "עודכן לאחרונה: 12 באוקטובר 2026",
  intro:
    "סידור רכב (CarSiddur) היא אפליקציה לניהול רכבים משותפים בקהילה, בארגון או בקבוצה. מסמך זה מסביר אילו פרטים האפליקציה שומרת, למה, מי רואה אותם ומה הזכויות שלך. את האפליקציה מפעיל עמרי גלס באופן אישי (\"המפעיל\", \"אנחנו\").",
  sections: [
    {
      heading: "1. אילו פרטים נשמרים",
      paragraphs: [
        "פרטי חשבון מ-Google: שם, כתובת דוא״ל ותמונת פרופיל, כפי שנמסרים בכניסה עם Google. איננו מקבלים את הסיסמה שלך.",
        "פרטים שאת/ה מוסיף/ה: שם תצוגה, מספר טלפון, הקבוצה ומקום היציאה הקבוע שלך, העדפות (למשל שאינך נוהג/ת), ושמות ושנות לידה של ילדים — רק כדי לתכנן מקומות ומושבי בטיחות.",
        "נתוני נסיעות: בקשות נסיעה (ימים, שעות, מוצא, יעד, עצירות, סוג הנסיעה והערות), הנוסעים שהוספת, הנסיעות שבוצעו, הצעות שינוי והתשובות להן, דיווחים על מצב הרכב, ויומן שינויים שמתעד מי שינה מה ומתי.",
        "התראות: הודעות בתיבת ההודעות, ואם אישרת התראות — כתובת המנוי של הדפדפן לקבלת התראות ושם סוג הדפדפן.",
        "מידע טכני: דיווחי תקלות (הודעת השגיאה, כתובת העמוד, גרסת האפליקציה וסוג הדפדפן) כדי שנוכל לתקן בעיות.",
        "הגדרות שנשמרות רק במכשיר שלך (למשל ערכת צבעים, תצוגה, תכונות ניסיוניות והיומנים שבחרת להציג) אינן נשלחות אלינו.",
      ],
    },
    {
      heading: "2. יומן Google (תכונה ניסיונית, לפי בחירה)",
      paragraphs: [
        "אם בחרת לחבר את יומן Google, האפליקציה מבקשת הרשאת קריאה בלבד (calendar.readonly) כדי להציג בעמעום את האירועים שלך מאחורי לוח הנסיעות שלך.",
        "האירועים נקראים ישירות מ-Google בדפדפן שלך, ואינם נשלחים לשרתים שלנו ואינם נשמרים אצלנו. אסימון הגישה נשמר רק בזיכרון של הכרטיסייה הפתוחה ונמחק כשהיא נסגרת. במכשיר נשמרת רק רשימת היומנים שבחרת.",
        "אפשר לנתק בכל עת ב\"ניתוק היומן\" באפליקציה, או לבטל את ההרשאה בחשבון Google שלך (myaccount.google.com/permissions).",
        "השימוש של סידור רכב במידע המתקבל מממשקי Google ובהעברתו עומד במדיניות נתוני המשתמש של שירותי ה-API של Google (Google API Services User Data Policy), כולל דרישות השימוש המוגבל (Limited Use). איננו משתמשים במידע הזה לפרסום, איננו מוכרים אותו ואיננו מעבירים אותו לאיש.",
      ],
    },
    {
      heading: "3. למה אנחנו משתמשים בפרטים",
      paragraphs: [
        "כדי להפעיל את השירות: לקבל בקשות נסיעה, לבנות את סידור הרכב, לחלק את הרכבים בהגינות (גם לפי היסטוריית הנסיעות של השבועות האחרונים), לשלוח התראות, לאפשר לרכזים ליצור איתך קשר, לשמור על אבטחת המערכת ולתקן תקלות.",
        "אין באפליקציה פרסומות, אין מכירה של מידע ואין כלי מעקב או ניתוח שיווקי.",
      ],
    },
    {
      heading: "4. מי רואה את הפרטים",
      paragraphs: [
        "חברי הקבוצה שלך רואים את הסידור שפורסם, כולל השמות שעל כל נסיעה, היעדים והשעות, ויכולים לראות את שמך ומספר הטלפון שלך כדי לתאם נסיעה משותפת.",
        "הרכזים והמנהלים של הקבוצה רואים את הבקשות ואת הפרטים הדרושים לתיאום. ההרשאות נאכפות במסד הנתונים עצמו, כך שכל אחד רואה רק את מה שתפקידו מאפשר.",
        "ספקי שירות שמפעילים את האפליקציה עבורנו: Supabase (מסד נתונים, כניסה ואחסון; השרתים בציריך, שווייץ), Cloudflare (אירוח האתר), Google (כניסה, ויומן אם חיברת אותו), ושירותי ההתראות של יצרני הדפדפנים (Google, Apple, Mozilla), שמעבירים את תוכן ההתראות למכשיר שלך. קישורי WhatsApp נפתחים באפליקציית WhatsApp של מי שלחץ עליהם, וההודעה נשלחת ממנה.",
        "לא נמסור פרטים לאחרים, אלא אם נידרש לכך על פי דין.",
      ],
    },
    {
      heading: "5. כמה זמן הפרטים נשמרים",
      paragraphs: [
        "פרטי החשבון נשמרים כל עוד החשבון פעיל. היסטוריית הסידורים נשמרת כדי לשמור על רצף הסידור ועל חלוקה הוגנת לאורך זמן. דיווחי תקלות נשמרים רק כל עוד הם נחוצים לבירור הבעיה. גיבויים של מסד הנתונים נשמרים בידי המפעיל.",
        "לבקשתך נמחק את הפרטים האישיים שלך או נהפוך אותם לאנונימיים, למעט מה שנדרש לשמירה על היסטוריית הסידור המשותפת או על פי דין.",
      ],
    },
    {
      heading: "6. הזכויות שלך",
      paragraphs: [
        "על פי הדין החל, ובכלל זה חוק הגנת הפרטיות, התשמ״א-1981, את/ה רשאי/ת לעיין בפרטים שנשמרו עליך, לבקש לתקן אותם או לבקש למחוק אותם. חלק מהפרטים אפשר לעדכן בעצמך במסך הפרופיל. לכל בקשה אחרת כתבו ל-{{email}}.",
      ],
    },
    {
      heading: "7. ילדים",
      paragraphs: [
        "האפליקציה מיועדת למבוגרים. שמות ושנות לידה של ילדים מוזנים רק בידי הורה או אפוטרופוס, כדי לתכנן מקומות ומושבי בטיחות ברכב.",
      ],
    },
    {
      heading: "8. אבטחה",
      paragraphs: [
        "כל התקשורת מוצפנת (HTTPS), והגישה לנתונים מוגבלת לפי תפקיד ברמת מסד הנתונים. שום מערכת אינה מאובטחת לחלוטין; אם גילית בעיית אבטחה, נשמח לשמוע ב-{{email}}.",
      ],
    },
    {
      heading: "9. שינויים במדיניות",
      paragraphs: [
        "אם המדיניות תשתנה, הגרסה המעודכנת תפורסם כאן עם תאריך העדכון, ועל שינוי מהותי נודיע באפליקציה.",
      ],
    },
    {
      heading: "10. יצירת קשר",
      paragraphs: ["עמרי גלס, {{email}}"],
    },
  ],
};

const privacyEn: LegalDocument = {
  title: "Privacy Policy",
  updated: "Last updated: October 12, 2026",
  intro:
    "CarSiddur (סידור רכב) is an app for managing shared vehicles in a community, organization or group. This policy explains what the app stores, why, who sees it and what your rights are. The app is operated by Omri Glass personally (\"the operator\", \"we\").",
  sections: [
    {
      heading: "1. What we store",
      paragraphs: [
        "Account details from Google: your name, email address and profile picture, as provided when you sign in with Google. We never receive your password.",
        "Details you add: display name, phone number, your group and usual departure place, preferences (for example that you do not drive), and children's names and birth years — only to plan seats and child safety seats.",
        "Ride data: ride requests (days, times, origin, destination, stops, ride type and notes), passengers you add, rides, change proposals and answers, vehicle condition reports, and a change log recording who changed what and when.",
        "Notifications: messages in your inbox and, if you allow notifications, your browser's push subscription address and browser type.",
        "Technical data: error reports (error message, page address, app version and browser type) so we can fix problems.",
        "Settings kept only on your device (for example theme, display, experimental features and the calendars you chose to show) are not sent to us.",
      ],
    },
    {
      heading: "2. Google Calendar (experimental, optional)",
      paragraphs: [
        "If you choose to connect Google Calendar, the app asks for read-only access (calendar.readonly) to show your events faintly behind your own ride schedule.",
        "Events are read directly from Google in your browser; they are never sent to our servers and never stored by us. The access token is kept only in the memory of the open browser tab and is gone when it closes. Only the list of calendars you picked is remembered on your device.",
        "You can disconnect at any time with \"ניתוק היומן\" (disconnect calendar) in the app, or revoke access in your Google Account (myaccount.google.com/permissions).",
        "CarSiddur's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. We do not use this information for advertising, do not sell it and do not share it with anyone.",
      ],
    },
    {
      heading: "3. How we use your data",
      paragraphs: [
        "To run the service: receive ride requests, build the vehicle schedule, share vehicles fairly (including by recent weeks' ride history), send notifications, let coordinators contact you, keep the system secure and fix problems.",
        "There are no ads, no sale of data and no marketing tracking or analytics tools.",
      ],
    },
    {
      heading: "4. Who sees your data",
      paragraphs: [
        "Members of your group see the published schedule, including the names on each ride, destinations and times, and may see your name and phone number to coordinate a shared ride.",
        "Your group's coordinators and administrators see requests and the details needed for coordination. Permissions are enforced in the database itself, so each person sees only what their role allows.",
        "Service providers that run the app for us: Supabase (database, sign-in and storage; servers in Zurich, Switzerland), Cloudflare (website hosting), Google (sign-in, and Calendar if you connect it), and the browser makers' push services (Google, Apple, Mozilla), which deliver notification content to your device. WhatsApp links open in the WhatsApp app of whoever taps them, and the message is sent from there.",
        "We do not disclose your data to anyone else unless required by law.",
      ],
    },
    {
      heading: "5. How long we keep it",
      paragraphs: [
        "Account details are kept while your account is active. Schedule history is kept to preserve the continuity of the schedule and fair sharing over time. Error reports are kept only as long as needed to investigate. Database backups are held by the operator.",
        "On request we delete or anonymize your personal data, except what is needed to preserve the shared schedule history or required by law.",
      ],
    },
    {
      heading: "6. Your rights",
      paragraphs: [
        "Under applicable law, including the Israeli Privacy Protection Law, 5741-1981, you may access the data stored about you and ask to correct or delete it. Some details can be updated yourself on the profile screen. For anything else, write to {{email}}.",
      ],
    },
    {
      heading: "7. Children",
      paragraphs: [
        "The app is intended for adults. Children's names and birth years are entered only by a parent or guardian, to plan seats and child safety seats.",
      ],
    },
    {
      heading: "8. Security",
      paragraphs: [
        "All communication is encrypted (HTTPS), and data access is limited by role at the database level. No system is completely secure; if you find a security issue, please tell us at {{email}}.",
      ],
    },
    {
      heading: "9. Changes",
      paragraphs: [
        "If this policy changes, the updated version will be posted here with its date, and significant changes will be announced in the app.",
      ],
    },
    {
      heading: "10. Contact",
      paragraphs: ["Omri Glass, {{email}}"],
    },
  ],
};

const termsHe: LegalDocument = {
  title: "תנאי שימוש",
  updated: "עודכן לאחרונה: 12 באוקטובר 2026",
  intro:
    "סידור רכב (CarSiddur) היא אפליקציה חינמית לניהול רכבים משותפים בקהילה, בארגון או בקבוצה. את האפליקציה מפעיל עמרי גלס באופן אישי (\"המפעיל\"). השימוש באפליקציה מהווה הסכמה לתנאים אלה ולמדיניות הפרטיות.",
  sections: [
    {
      heading: "1. השירות",
      paragraphs: [
        "כל קבוצה שמשתמשת באפליקציה מנוהלת בידי המנהלים והרכזים שלה. הגישה לקבוצה ניתנת באישור מנהל הקבוצה, והוא רשאי להשעות או להסיר גישה.",
      ],
    },
    {
      heading: "2. האפליקציה מציעה, אנשים מחליטים",
      paragraphs: [
        "הסידור מוצע על ידי תוכנה ונקבע בידי רכזי הקבוצה. אין התחייבות שרכב יהיה פנוי בזמן מסוים, ובקשות עשויות להשתנות, להידחות או לעבור לרשימת ההמתנה.",
      ],
    },
    {
      heading: "3. כללי הקבוצה והחוק גוברים",
      paragraphs: [
        "השימוש ברכבים כפוף לכללי הקבוצה שלך, לרישיון נהיגה ולביטוח בתוקף ולדין. האפליקציה אינה מחליפה אותם. הנהג/ת אחראי/ת לרכב ולנהיגה על פי הדין וכללי הקבוצה. המפעיל אינו הבעלים של הרכבים ואינו אחראי לרכבים, לתאונות, לנזקים או לקנסות.",
      ],
    },
    {
      heading: "4. האחריות שלך",
      paragraphs: [
        "למסור פרטים נכונים ולשמור על החשבון שלך לעצמך.",
        "להגיש בקשה בשם אחרים, להוסיף נוסעים או לרשום ילדים רק ברשותם (או ברשות ההורה או האפוטרופוס).",
        "לא לנסות לגשת לנתונים שאינם מיועדים לך, לא לשבש את פעולת השירות ולא לאסוף ממנו נתונים באופן אוטומטי.",
        "הערות שאת/ה כותב/ת עשויות להיות גלויות לאחרים בקבוצה — כתבו בכבוד.",
      ],
    },
    {
      heading: "5. זמינות ותכונות ניסיוניות",
      paragraphs: [
        "השירות ניתן כמות שהוא (\"AS IS\") וכפי שהוא זמין, על גבי שירותי אירוח חינמיים. הוא עשוי להשתנות, להיעצר זמנית או להיפסק. תכונות ניסיוניות עלולות לא לעבוד כמצופה, להשתנות או להיעלם.",
      ],
    },
    {
      heading: "6. הגבלת אחריות",
      paragraphs: [
        "במידה המרבית המותרת בדין, המפעיל לא יישא באחריות לנזק עקיף או תוצאתי, לנסיעה שהוחמצה או לאובדן הנובע מהשימוש בשירות או מאי-זמינותו.",
      ],
    },
    {
      heading: "7. שירותים של צדדים שלישיים",
      paragraphs: [
        "כניסה עם Google, יומן Google ו-WhatsApp כפופים גם לתנאים של החברות המספקות אותם.",
      ],
    },
    {
      heading: "8. הפסקת שימוש",
      paragraphs: [
        "אפשר להפסיק להשתמש בשירות בכל עת ולבקש למחוק את הפרטים שלך, כמתואר במדיניות הפרטיות.",
      ],
    },
    {
      heading: "9. שינויים בתנאים",
      paragraphs: [
        "התנאים עשויים להתעדכן. הגרסה המעודכנת תפורסם כאן עם תאריך העדכון, והמשך השימוש לאחר מכן מהווה הסכמה לה.",
      ],
    },
    {
      heading: "10. דין וסמכות שיפוט",
      paragraphs: ["על תנאים אלה יחול הדין הישראלי, וסמכות השיפוט נתונה לבתי המשפט המוסמכים בישראל."],
    },
    {
      heading: "11. יצירת קשר",
      paragraphs: ["עמרי גלס, {{email}}"],
    },
  ],
};

const termsEn: LegalDocument = {
  title: "Terms of Use",
  updated: "Last updated: October 12, 2026",
  intro:
    "CarSiddur (סידור רכב) is a free app for managing shared vehicles in a community, organization or group. It is operated by Omri Glass personally (\"the operator\"). By using the app you agree to these terms and to the privacy policy.",
  sections: [
    {
      heading: "1. The service",
      paragraphs: [
        "Each group using the app is managed by its own administrators and coordinators. Access to a group is granted by its administrator, who may suspend or remove it.",
      ],
    },
    {
      heading: "2. The app proposes, people decide",
      paragraphs: [
        "The schedule is suggested by software and decided by your group's coordinators. No vehicle is guaranteed at any time, and requests may be changed, declined or put on the waiting list.",
      ],
    },
    {
      heading: "3. Your group's rules and the law come first",
      paragraphs: [
        "Using the vehicles is subject to your group's rules, a valid driving licence and insurance, and the law. The app does not replace them. The driver is responsible for the vehicle and the driving under the law and the group's rules. The operator does not own the vehicles and is not responsible for vehicles, accidents, damage or fines.",
      ],
    },
    {
      heading: "4. Your responsibilities",
      paragraphs: [
        "Provide accurate details and keep your account to yourself.",
        "File requests for others, add passengers or register children only with their permission (or that of a parent or guardian).",
        "Do not try to access data not meant for you, disrupt the service or collect data from it automatically.",
        "Notes you write may be visible to others in your group — please be respectful.",
      ],
    },
    {
      heading: "5. Availability and experimental features",
      paragraphs: [
        "The service is provided \"as is\" and \"as available\" on free hosting tiers. It may change, pause or stop. Experimental features may not work as expected, may change or may be removed.",
      ],
    },
    {
      heading: "6. Limitation of liability",
      paragraphs: [
        "To the fullest extent permitted by law, the operator is not liable for indirect or consequential damage, missed rides or losses arising from use of the service or its unavailability.",
      ],
    },
    {
      heading: "7. Third-party services",
      paragraphs: ["Sign in with Google, Google Calendar and WhatsApp are also subject to their providers' terms."],
    },
    {
      heading: "8. Stopping",
      paragraphs: ["You may stop using the service at any time and ask for your data to be deleted, as described in the privacy policy."],
    },
    {
      heading: "9. Changes to these terms",
      paragraphs: [
        "These terms may be updated. The updated version will be posted here with its date, and continued use afterwards means you accept it.",
      ],
    },
    {
      heading: "10. Governing law",
      paragraphs: ["These terms are governed by the laws of the State of Israel, and the competent courts in Israel have jurisdiction."],
    },
    {
      heading: "11. Contact",
      paragraphs: ["Omri Glass, {{email}}"],
    },
  ],
};

export const legalDocuments = {
  privacy: { he: privacyHe, en: privacyEn },
  terms: { he: termsHe, en: termsEn },
} as const;
