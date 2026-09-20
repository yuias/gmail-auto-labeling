import { log } from "./log";
import type {
  ClassificationResult,
  LabelConfig,
  MessageState,
  QuestionSpec,
  SystemOneCaller,
} from "./types";

// Question ids are fixed: "category" for the choice, then one noul per flag
// key, in config order (see types.ts).
export function buildQuestions(config: LabelConfig): QuestionSpec[] {
  const questions: QuestionSpec[] = [
    {
      id: "category",
      type: "choice",
      instructions: config.category.instructions,
      options: Object.fromEntries(
        Object.entries(config.category.options).map(([key, option]) => [key, option.criteria]),
      ),
    },
  ];
  for (const [id, flag] of Object.entries(config.flags)) {
    questions.push({ id, type: "noul", instructions: flag.instructions, criteria: flag.criteria });
  }
  return questions;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// The Jev caller's raw answers may come back as an object keyed by question
// id, or as an array of `{ id, ... }` entries; this flattens either into a
// lookup keyed by id.
function indexAnswers(rawAnswers: unknown): Map<string, Record<string, unknown>> {
  const answers = new Map<string, Record<string, unknown>>();
  if (Array.isArray(rawAnswers)) {
    for (const entry of rawAnswers) {
      const record = asRecord(entry);
      const id = record?.id;
      if (!record || typeof id !== "string") {
        throw new Error("jev: answer array entry missing string id");
      }
      answers.set(id, record);
    }
    return answers;
  }
  const record = asRecord(rawAnswers);
  if (!record) {
    throw new Error("jev: response missing answers");
  }
  for (const [id, value] of Object.entries(record)) {
    const answer = asRecord(value);
    if (!answer) {
      throw new Error(`jev: answer for "${id}" is not an object`);
    }
    answers.set(id, answer);
  }
  return answers;
}

export function normalizeResponse(raw: unknown, config: LabelConfig): ClassificationResult {
  const root = asRecord(raw);
  if (!root) {
    throw new Error("jev: response is not an object");
  }
  const model = root.model;
  if (typeof model !== "string") {
    throw new Error("jev: response missing string model");
  }

  const answers = indexAnswers(root.answers);

  const categoryAnswer = answers.get("category");
  if (!categoryAnswer) {
    throw new Error('jev: missing answer for question "category"');
  }
  const choice = categoryAnswer.choice;
  if (typeof choice !== "string") {
    throw new Error("jev: category answer missing string choice");
  }
  const confidence = categoryAnswer.confidence;
  if (typeof confidence !== "number") {
    throw new Error("jev: category answer missing numeric confidence");
  }
  const rawProbabilities = asRecord(categoryAnswer.probabilities) ?? {};
  const probabilities: Record<string, number> = {};
  for (const key of Object.keys(config.category.options)) {
    const probability = rawProbabilities[key];
    probabilities[key] = typeof probability === "number" ? probability : 0;
  }

  const flags: Record<string, number> = {};
  for (const id of Object.keys(config.flags)) {
    const flagAnswer = answers.get(id);
    if (!flagAnswer) {
      throw new Error(`jev: missing answer for question "${id}"`);
    }
    const noul = flagAnswer.noul;
    if (typeof noul !== "number") {
      throw new Error(`jev: noul answer for "${id}" is not a number`);
    }
    flags[id] = noul;
  }

  return { model, category: { choice, probabilities, confidence }, flags };
}

export async function classify(
  caller: SystemOneCaller,
  state: MessageState,
  config: LabelConfig,
): Promise<ClassificationResult> {
  const raw = await caller.systemOne({
    model: config.model,
    state,
    questions: buildQuestions(config),
  });
  const result = normalizeResponse(raw, config);
  log("jev", { model: result.model });
  return result;
}
