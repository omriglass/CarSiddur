/**
 * AI1 (docs/TODO.md "Ask in words", owner 2026-11-20): the system prompt and the structured-output schema for the
 * "ask in words" box. One generative call returns one JSON object; our code validates every field afterwards (the
 * model proposes, the member decides). Kept free of Deno/Node specifics so the evaluation runner
 * (`scripts/ai-eval/run.mjs`, Node type stripping) measures exactly what the edge function will send.
 *
 * No Hebrew here (hard rule 3): place names, people and the member's text arrive as data in the user turn.
 */

export const PROMPT_VERSION = "ai1-2026-11-21.7";

export interface AskPlace { name: string; aliases?: string[] }
export interface AskPerson { name: string; kind: "child" | "member"; drives?: boolean }
export interface AskRide {
  ref: string;            // RIDE_1, RIDE_2, … — never a database id
  date: string;           // YYYY-MM-DD
  weekday: string;        // English weekday name
  start: string;          // HH:MM, departure
  end: string | null;     // HH:MM, back home / pickup; null for a one-way
  trip_type: "round_trip" | "one_way" | "drop_off";
  origin: string;
  destination: string;
  stops: { leg: "out" | "return"; place: string }[];
  people: string[];       // everyone besides the member
}
export interface AskContext {
  now: string;            // YYYY-MM-DDTHH:MM, Asia/Jerusalem wall clock
  weekday: string;        // today's English weekday
  calendar: { date: string; weekday: string }[];  // the next 14 days, so dates are looked up, not computed
  home: string;           // the department's home place
  places: AskPlace[];
  people: AskPerson[];    // the member's children and the people they usually ride with
  my_rides: AskRide[];    // the member's own upcoming rides
}

export const SYSTEM_PROMPT = `You read one short message from a member of a kibbutz car-sharing app and turn it into one JSON object.
Messages are usually Hebrew, sometimes English, often informal or misspelled. Never chat; only fill the schema.

Intents:
- "new_request": the member wants a new ride (a car for themselves, or a drop-off / pickup).
- "find_ride": the member asks who they can join, whether someone is going somewhere, or whether a car is free.
- "edit_request": the member changes one of their own upcoming rides listed in my_rides.
- "cancel_request": the member no longer needs one of their rides in my_rides.
- "ride_info": the member only ASKS about their own rides in my_rides — when it leaves or returns, which car, who drives, who
  rides along, where from — and changes nothing ("when is my ride on Saturday?", "which car is my Monday ride?", "what rides do
  I have this week?"). Asking whether SOMEONE ELSE goes somewhere or whether a car is free is "find_ride", not "ride_info".
- "unclear": anything else (small talk, questions the app cannot answer, messages to the coordinator, several rides at once).

Rules:
- Dates: look the day up in the calendar given in the context; never compute it. "today"/"tomorrow" are relative to "now".
  A bare weekday means its next occurrence after today (today itself only when said "today"). "next <weekday>" (in Hebrew the weekday
  followed by the word for "next") means that weekday in the following week when it would otherwise fall within the next 6 days.
- Times are 24-hour HH:MM. Spoken Hebrew times count: "at eight" = 08:00, "quarter to ten" = 09:45, "and a half" = :30.
  Hours 1-6 said without context mean the morning; "7 in the evening" = 19:00. A vague time ("in the morning", "after noon")
  is not a time: leave it null and ask "what_time".
- time_mode "arrive_by" when the member must BE somewhere by a time ("to get there by", "to be at ... by", an appointment at a time);
  "depart" when they leave at a time. A place followed by "until <time>" / "by <time>" (Hebrew "ad <time>", e.g. "<place> tomorrow
  ad 10") is an arrive_by time, never a return_time. A return time is only one said about coming back ("back at", "return at").
- trip_type: "drop_off" for a drop-off / lift (Hebrew "hakpatsa", "drop me", "to the train") or a pickup only; "one_way" when they say
  one way only;
  "round_trip" when they go and come back with the car; null when not said.
- Places: destination/origin/stops each carry "text" (the member's words, verbatim) and "list_name" (exactly one of the context's place names
  when the words clearly mean it, typos and aliases included; null otherwise — never force a different place). Origin null = from home.
- A shop or business in a town ("<shop> in <town>", in Hebrew "<shop> be-<town>": the hardware store in Baqa = Baqa al-Gharbiyye,
  the supermarket in Pardes Hanna): the place is the TOWN — text = the town's words only, list_name = the town when listed.
  Never make the shop the place.
- errand "shopping" when the member goes shopping (a shop, supermarket, groceries, hardware store, mall, market); null otherwise.
- people: names exactly as written in the context's people list when they match (children included); unknown names as written.
  "the kids" = all the member's children. The member themselves is never in people. extra_adults = unnamed extra adults
  ("a friend", "a guest", "two more" are extra_adults, not people).
- needs: "large_trunk" for a lot of luggage / a big trunk; "tow_hitch" for a towing hook.
- find_ride: fill date, time, time_mode, destination and origin exactly as for a new_request (the app searches with them);
  never ask anything.
- ride_info: matching_rides lists the ref of every ride in my_rides the question is about (by day, place, time, people); every
  ride when it asks about all of them or about a whole week. Set date when a single day is said. Never ask anything.
- Edits and cancels: matching_rides lists the ref of EVERY ride in my_rides the message could mean (by day, place, time, people).
  Never choose between several — list them all; the app asks the member. An empty list when none fits.
  For an edit fill ONLY what changes: a new departure or return time in time / return_time, a relative change in
  start_shift_minutes / end_shift_minutes ("an hour longer" / "extend by an hour" = end_shift_minutes 60, "half an hour earlier" =
  start_shift_minutes -30), added stops in stops, added people in people, removed people in remove_people, a new trip type in trip_type.
- In Hebrew the verb "to lengthen / extend" (or "to shorten") followed by the word for "in an hour" / "in half an hour" means
  BY that amount. Its imperative "ta'arich" (lengthen!) is spelled exactly like the noun "date": at the start of a message about
  a ride it is the verb. "ta'arich ... be-sha'a" = extend by an hour: end_shift_minutes 60 / 30 (shortening: negative), never a time to ask about. "Earlier/later by" works the same
  on the start (start_shift_minutes) unless the member says "the return".
  An edit whose verb is extend / lengthen / shorten / make earlier / make later NEVER asks "what_time": "be-sha'a" there is
  "by one hour", "be-chatsi sha'a" "by half an hour", "be-sha'atayim" "by two hours". Examples (transliterated):
  "ta'arich et ha-nesi'a le-<place> be-yom rishon be-sha'a" → edit_request, end_shift_minutes 60, ask null;
  "ta'arich ota be-sha'a" (a follow-up about the draft's ride) → end_shift_minutes 60, ask null;
  "tekatser et ha-nesi'a be-chatsi sha'a" → end_shift_minutes -30.
- A message describing a trip with its own destination and hours is a new_request, even when the member already has rides that day —
  also when it is the SAME day and place as a ride in my_rides but states its own hours ("I need to be in <place> at 8 and back at
  12, and stop at <place2> on the way"). An edit refers to an existing ride ("my ride", "the ride", "it") or changes it relative
  to what it is; a message that says "I need to be / I need to go" with times is a new_request.
  A stop added "on the way" / "on the way back" on a day with a ride in my_rides, with no hours of its own ("I'll stop at the
  supermarket on the way back on Wednesday"), is an edit_request of that ride (stops, leg "return" for the way back).
- Never assume a day: no day said means date null (ask "what_day"). "now" / "right now" means today, and time = now's time.
- A duration ("for two hours", "for an hour") goes in duration_minutes; do not convert it into a return time yourself.
- Never ask when they come back: no return said means return_time null (the app estimates it).
- ask: what the app must ask the member next, or null when nothing is missing. For new_request a missing date asks "what_day",
  a missing destination asks "what_place", a missing or vague time asks "what_time".
- Leave every field you were not told null or empty. Never invent values.

Follow-ups: the user turn may also carry "Draft so far" (the JSON you returned before, after the app's checks) and
"Earlier messages". Then the new message usually answers the app's question or corrects the draft: return the WHOLE
updated draft — keep the draft's intent and every field the new message does not change; for an edit or cancel keep its ride in
matching_rides. A bare time, day, place or name answers the open question ("ask"). Start a new draft only when the new
message is clearly about a different ride.`;

const placeRef = {
  type: "OBJECT",
  nullable: true,
  properties: {
    text: { type: "STRING" },
    list_name: { type: "STRING", nullable: true },
  },
  required: ["text", "list_name"],
} as const;

/** Gemini `responseSchema` (OpenAPI subset). */
export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: ["new_request", "find_ride", "edit_request", "cancel_request", "ride_info", "unclear"] },
    matching_rides: { type: "ARRAY", items: { type: "STRING" } },
    date: { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
    time_mode: { type: "STRING", nullable: true, enum: ["depart", "arrive_by"] },
    time: { type: "STRING", nullable: true, description: "HH:MM" },
    return_time: { type: "STRING", nullable: true, description: "HH:MM" },
    trip_type: { type: "STRING", nullable: true, enum: ["round_trip", "one_way", "drop_off"] },
    destination: placeRef,
    origin: placeRef,
    stops: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { leg: { type: "STRING", enum: ["out", "return"] }, text: { type: "STRING" }, list_name: { type: "STRING", nullable: true } },
        required: ["leg", "text", "list_name"],
      },
    },
    people: { type: "ARRAY", items: { type: "STRING" } },
    remove_people: { type: "ARRAY", items: { type: "STRING" } },
    extra_adults: { type: "INTEGER", nullable: true },
    needs: { type: "ARRAY", items: { type: "STRING", enum: ["large_trunk", "tow_hitch"] } },
    start_shift_minutes: { type: "INTEGER", nullable: true },
    end_shift_minutes: { type: "INTEGER", nullable: true },
    duration_minutes: { type: "INTEGER", nullable: true },
    errand: { type: "STRING", nullable: true, enum: ["shopping"] },
    ask: { type: "STRING", nullable: true, enum: ["which_ride", "what_day", "what_place", "what_time"] },
  },
  required: ["intent", "matching_rides", "date", "time_mode", "time", "return_time", "trip_type", "destination", "origin", "stops",
    "people", "remove_people", "extra_adults", "needs", "start_shift_minutes", "end_shift_minutes", "duration_minutes", "errand", "ask"],
  propertyOrdering: ["intent", "matching_rides", "date", "time_mode", "time", "return_time", "trip_type", "destination", "origin", "stops",
    "people", "remove_people", "extra_adults", "needs", "start_shift_minutes", "end_shift_minutes", "duration_minutes", "errand", "ask"],
} as const;

/** The user turn: the context as JSON, then the member's message. */
/** A follow-up turn: the checked draft of the previous turn and the member's earlier messages, oldest first. */
export interface AskPrevious { draft: object | null; messages: string[] }

export function buildUserTurn(context: AskContext, message: string, previous?: AskPrevious | null): string {
  const earlier = previous && (previous.draft || previous.messages.length)
    ? `Draft so far:\n${JSON.stringify(previous.draft)}\n\nEarlier messages:\n${JSON.stringify(previous.messages)}\n\n`
    : "";
  return `Context:\n${JSON.stringify(context)}\n\n${earlier}Message:\n${message}`;
}

/** The `generateContent` request body (REST, v1beta). */
export function buildGenerateRequest(context: AskContext, message: string, previous?: AskPrevious | null) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: buildUserTurn(context, message, previous) }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  };
}
