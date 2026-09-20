import { describe, expect, it } from "vitest";
import { buildQuestions, classify, normalizeResponse } from "../../src/core/jev";
import type {
  LabelConfig,
  MessageState,
  SystemOneCaller,
  SystemOneRequest,
} from "../../src/core/types";

const config: LabelConfig = {
  model: "jev-latest",
  body: { maxChars: 8000 },
  category: {
    instructions: "Classify the mail",
    maxLabels: 2,
    thresholds: { primary: 0.5, secondary: 0.25 },
    options: {
      receipt: { label: "Receipt", criteria: "receipts" },
      shipped: { label: "Shipped", criteria: "shipping" },
      scheduled: { label: "Scheduled", criteria: "bookings" },
      ads: { label: "Ads", criteria: "promotions" },
      other: { label: null, criteria: "none of the above" },
    },
  },
  flags: {
    action: { label: "Action", threshold: 0.7, instructions: "action needed", criteria: "act" },
    human: { label: "Human", threshold: 0.7, instructions: "written by a person", criteria: "人" },
  },
};

const state: MessageState = {
  subject: "Your receipt",
  from: { name: "Store", address: "store@example.com", domain: "example.com" },
  to_me_directly: true,
  gmail_category: null,
  bulk_signals: { list_unsubscribe: false, precedence: null, auto_submitted: null },
  body: "Thanks for your purchase.",
};

function keyedRaw() {
  return {
    model: "jev-1.13.0",
    answers: {
      category: {
        type: "choice",
        choice: "receipt",
        confidence: 0.9,
        probabilities: { receipt: 0.8, scheduled: 0.1 },
      },
      action: { type: "noul", noul: 0.2 },
      human: { type: "noul", noul: 0.9 },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function arrayRaw() {
  return {
    model: "jev-1.13.0",
    answers: [
      {
        id: "category",
        type: "choice",
        choice: "receipt",
        confidence: 0.9,
        probabilities: { receipt: 0.8, scheduled: 0.1 },
      },
      { id: "action", type: "noul", noul: 0.2 },
      { id: "human", type: "noul", noul: 0.9 },
    ],
  };
}

class StubCaller implements SystemOneCaller {
  lastRequest: SystemOneRequest | undefined;
  constructor(private readonly raw: unknown) {}
  async systemOne(request: SystemOneRequest): Promise<unknown> {
    this.lastRequest = request;
    return this.raw;
  }
}

describe("buildQuestions", () => {
  it("yields the category choice with all options, then one noul per flag, in config order", () => {
    expect(buildQuestions(config)).toEqual([
      {
        id: "category",
        type: "choice",
        instructions: "Classify the mail",
        options: {
          receipt: "receipts",
          shipped: "shipping",
          scheduled: "bookings",
          ads: "promotions",
          other: "none of the above",
        },
      },
      { id: "action", type: "noul", instructions: "action needed", criteria: "act" },
      { id: "human", type: "noul", instructions: "written by a person", criteria: "人" },
    ]);
  });
});

describe("classify", () => {
  it("forwards model, state, and questions, and normalizes a keyed answer layout", async () => {
    const caller = new StubCaller(keyedRaw());
    const result = await classify(caller, state, config);

    expect(caller.lastRequest).toEqual({
      model: config.model,
      state,
      questions: buildQuestions(config),
    });
    expect(result).toEqual({
      model: "jev-1.13.0",
      category: {
        choice: "receipt",
        confidence: 0.9,
        probabilities: { receipt: 0.8, shipped: 0, scheduled: 0.1, ads: 0, other: 0 },
      },
      flags: { action: 0.2, human: 0.9 },
    });
  });

  it("normalizes an array answer layout the same way", async () => {
    const caller = new StubCaller(arrayRaw());
    const result = await classify(caller, state, config);

    expect(result).toEqual({
      model: "jev-1.13.0",
      category: {
        choice: "receipt",
        confidence: 0.9,
        probabilities: { receipt: 0.8, shipped: 0, scheduled: 0.1, ads: 0, other: 0 },
      },
      flags: { action: 0.2, human: 0.9 },
    });
  });
});

describe("normalizeResponse", () => {
  it("throws when an answer is missing", () => {
    const raw: Record<string, unknown> = keyedRaw();
    raw.answers = { category: keyedRaw().answers.category, action: keyedRaw().answers.action };
    expect(() => normalizeResponse(raw, config)).toThrow(/human/);
  });

  it("throws when a noul answer is non-numeric", () => {
    const raw = keyedRaw();
    (raw.answers as Record<string, unknown>).human = { type: "noul", noul: "yes" };
    expect(() => normalizeResponse(raw, config)).toThrow(/human/);
  });
});
