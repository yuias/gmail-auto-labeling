// Only file that imports @typesafe-ai/sdk; everything vendor-specific about
// its request/response shape stays here so src/core/jev.ts only depends on
// the SystemOneCaller interface.
//
// The installed SDK (0.6.0) differs from the summary in the spec: the client
// class is `TypeSafeClient`, its questions map keys `NoulQuestion`/
// `ChoiceQuestion`/`ScoreQuestion` by name (no separate choice()/noul()
// helpers are required; they just build the same plain objects), and a noul
// question's `criteria` is `{ true?, false? } | null` rather than a single
// value. `TypeSafeClient` guards every `process` access with a `typeof
// process === "undefined"` check and never touches `Buffer` or `require`, so
// it loads under workerd (confirmed in test/workers/jev-sdk.test.ts) and the
// plain-fetch fallback described in the spec is not needed.
import { type EntryType, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Criteria, QuestionSpec, SystemOneCaller } from "./types";

// The SDK's `EntryType` accepts strings, plain objects, and arrays, but not
// values typed as `Record<string, unknown>`; stringifying object criteria
// keeps this file simple instead of re-deriving JSON-safe types.
function toEntry(criteria: Criteria): string {
  return typeof criteria === "string" ? criteria : JSON.stringify(criteria);
}

function toSdkQuestion(question: QuestionSpec) {
  if (question.type === "choice") {
    return {
      type: "choice" as const,
      instructions: question.instructions,
      criteria: Object.fromEntries(
        Object.entries(question.options).map(([key, criteria]) => [key, toEntry(criteria)]),
      ),
    };
  }
  // Our Criteria describes what a "yes" answer means; the SDK's noul
  // criteria splits by outcome, so "false" is left undescribed.
  return {
    type: "noul" as const,
    instructions: question.instructions,
    criteria: { true: toEntry(question.criteria) },
  };
}

export function createJevCaller(apiKey: string): SystemOneCaller {
  const client = new TypeSafeClient({ apiKey });
  return {
    async systemOne(request) {
      const questions = Object.fromEntries(
        request.questions.map((question) => [question.id, toSdkQuestion(question)]),
      );
      // Our SystemOneRequest keeps `state` opaque (`unknown`) to callers; buildState
      // always produces JSON-compatible data, which is what the SDK's EntryType expects.
      return await client.systemOne({
        model: request.model,
        state: request.state as EntryType,
        questions,
      });
    },
  };
}
