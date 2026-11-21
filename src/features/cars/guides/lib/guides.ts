/**
 * Pure helpers of the car guides (REQ item 259, "איך עושים…"): reading the stored steps, the order of a car's guides
 * (the department's topics in their order, then the car's own guides by title), the cars a guide can be copied from
 * (same model first) and the step viewer's gestures — an RTL app, so the next step comes from the left: a swipe
 * with the finger moving right, or ArrowLeft, goes forward.
 */

export interface GuideStep {
  text: string;
}

/** Stored steps are `[{ "text" }]`; anything else is dropped. */
export function parseSteps(raw: unknown): GuideStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((step) => {
    const text = typeof step === "string" ? step : step && typeof step === "object" && typeof (step as { text?: unknown }).text === "string" ? (step as { text: string }).text : "";
    return text.trim() ? [{ text: text.trim() }] : [];
  });
}

interface TopicLike {
  id: string;
  title: string;
  required: boolean;
  active: boolean;
  position: number;
}

interface GuideLike {
  id: string;
  car_id: string;
  topic_id: string | null;
  title: string;
  steps: readonly GuideStep[];
}

export type GuideRow<G extends GuideLike, T extends TopicLike> =
  | { kind: "guide"; guide: G; topic: T | null }
  | { kind: "missing"; topic: T };

const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, "he");

/**
 * A car's guides in reading order: each active topic (its guide, or a "missing" row when it has none), then the
 * guides of inactive or deleted topics and the car's own guides, by title.
 */
export function guideRows<G extends GuideLike, T extends TopicLike>(topics: readonly T[], guides: readonly G[]): GuideRow<G, T>[] {
  const ordered = [...topics].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const byTopic = new Map(guides.filter((g) => g.topic_id).map((g) => [g.topic_id as string, g]));
  const rows: GuideRow<G, T>[] = [];
  const used = new Set<string>();
  for (const topic of ordered) {
    if (!topic.active) continue;
    const guide = byTopic.get(topic.id);
    if (guide) {
      rows.push({ kind: "guide", guide, topic });
      used.add(guide.id);
    } else {
      rows.push({ kind: "missing", topic });
    }
  }
  const topicById = new Map(topics.map((t) => [t.id, t]));
  for (const guide of guides.filter((g) => !used.has(g.id)).sort(byTitle)) {
    rows.push({ kind: "guide", guide, topic: guide.topic_id ? topicById.get(guide.topic_id) ?? null : null });
  }
  return rows;
}

/** The required topics still missing on a car, in topic order. */
export function missingRequired<T extends TopicLike>(rows: readonly GuideRow<GuideLike, T>[]): T[] {
  return rows.flatMap((row) => (row.kind === "missing" && row.topic.required ? [row.topic] : []));
}

const sameModel = (a: string | null | undefined, b: string | null | undefined) =>
  !!a?.trim() && !!b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface CopyCandidate<G extends GuideLike> {
  guide: G;
  carName: string;
  sameModel: boolean;
}

/**
 * Guides of the department's other cars that can be copied into this one: for a topic, the other cars' guides on that
 * topic; for a car's own guide, every other car's guide. Same model first (the model names compare trimmed, ignoring
 * case), then by car name and title.
 */
export function copyCandidates<G extends GuideLike>(input: {
  guides: readonly G[];
  cars: readonly { id: string; name: string; model?: string | null }[];
  carId: string;
  topicId: string | null;
}): CopyCandidate<G>[] {
  const cars = new Map(input.cars.map((c) => [c.id, c]));
  const model = cars.get(input.carId)?.model ?? null;
  return input.guides
    .filter((g) => g.car_id !== input.carId && cars.has(g.car_id) && g.steps.length > 0)
    .filter((g) => (input.topicId ? g.topic_id === input.topicId : true))
    .map((guide) => {
      const car = cars.get(guide.car_id);
      return { guide, carName: car?.name ?? "", sameModel: sameModel(model, car?.model) };
    })
    .sort((a, b) => Number(b.sameModel) - Number(a.sameModel)
      || a.carName.localeCompare(b.carName, "he")
      || a.guide.title.localeCompare(b.guide.title, "he")
      || a.guide.id.localeCompare(b.guide.id));
}

export type StepMove = "next" | "prev";

/** A horizontal swipe of at least `threshold` px: finger moving right = next (RTL), left = previous. */
export function swipeMove(dx: number, dy: number, threshold = 40): StepMove | null {
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return null;
  return dx > 0 ? "next" : "prev";
}

/** Keyboard in the viewer (RTL): ArrowLeft / Enter / Space = next, ArrowRight = previous. */
export function keyMove(key: string): StepMove | null {
  if (key === "ArrowLeft" || key === "Enter" || key === " ") return "next";
  if (key === "ArrowRight") return "prev";
  return null;
}

/** Steps from the editor's text boxes: trimmed, blanks dropped. */
export function cleanSteps(texts: readonly string[]): GuideStep[] {
  return texts.map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
}

/** Moves item `index` one place up (-1) or down (+1); out of range = unchanged. */
export function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const to = index + direction;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  [next[index], next[to]] = [next[to] as T, next[index] as T];
  return next;
}
