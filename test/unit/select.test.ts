import { describe, expect, it } from "vitest";
import { selectLabels } from "../../src/core/select";
import type { ClassificationResult, LabelConfig } from "../../src/core/types";

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

function makeResult(
  probabilities: Record<string, number>,
  flags: Record<string, number> = {},
): ClassificationResult {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return {
    model: "jev-1.13.0",
    category: { choice, probabilities, confidence: 0.8 },
    flags,
  };
}

describe("selectLabels", () => {
  it("applies only the top category when the rest are below the secondary threshold", () => {
    const result = makeResult({ receipt: 0.8, scheduled: 0.1, other: 0.1 });
    expect(selectLabels(result, config)).toEqual(["Receipt"]);
  });

  it("applies two categories when the second clears the secondary threshold", () => {
    const result = makeResult({ receipt: 0.6, scheduled: 0.3, other: 0.1 });
    expect(selectLabels(result, config)).toEqual(["Receipt", "Scheduled"]);
  });

  it("applies no category when the catch-all wins", () => {
    const result = makeResult({ other: 0.7, ads: 0.2, receipt: 0.1 });
    expect(selectLabels(result, config)).toEqual([]);
  });

  it("applies no category when the catch-all wins even above the primary threshold", () => {
    // The catch-all takes the choice, so a category over primary is still ignored.
    const result = makeResult({ receipt: 0.5, other: 0.5 });
    result.category.choice = "other";
    expect(selectLabels(result, config)).toEqual([]);
  });

  it("applies no category when the top category is below the primary threshold", () => {
    const result = makeResult({ receipt: 0.4, shipped: 0.3, other: 0.3 });
    expect(selectLabels(result, config)).toEqual([]);
  });

  it("treats a probability exactly at a threshold as met", () => {
    const result = makeResult({ receipt: 0.5, scheduled: 0.25, other: 0.25 });
    expect(selectLabels(result, config)).toEqual(["Receipt", "Scheduled"]);
  });

  it("respects a larger category limit", () => {
    const wider: LabelConfig = {
      ...config,
      category: { ...config.category, maxLabels: 3 },
    };
    const result = makeResult({ receipt: 0.4, scheduled: 0.32, shipped: 0.28, other: 0 });
    result.category.choice = "receipt";
    expect(
      selectLabels(result, {
        ...wider,
        category: { ...wider.category, thresholds: { primary: 0.4, secondary: 0.25 } },
      }),
    ).toEqual(["Receipt", "Scheduled", "Shipped"]);
  });

  it("orders categories by probability", () => {
    const result = makeResult({ scheduled: 0.55, receipt: 0.35, other: 0.1 });
    expect(selectLabels(result, config)).toEqual(["Scheduled", "Receipt"]);
  });

  it("adds flags independently of the category limit and after the categories", () => {
    const result = makeResult(
      { receipt: 0.6, scheduled: 0.3, other: 0.1 },
      { action: 0.9, human: 0.8 },
    );
    expect(selectLabels(result, config)).toEqual(["Receipt", "Scheduled", "Action", "Human"]);
  });

  it("adds a flag on its own when no category applies", () => {
    const result = makeResult({ other: 0.9, receipt: 0.1 }, { action: 0.7, human: 0.2 });
    expect(selectLabels(result, config)).toEqual(["Action"]);
  });

  it("omits a flag whose value is below its threshold", () => {
    const result = makeResult({ receipt: 0.9, other: 0.1 }, { action: 0.69, human: 0.7 });
    expect(selectLabels(result, config)).toEqual(["Receipt", "Human"]);
  });

  it("treats a missing flag answer as not met", () => {
    const result = makeResult({ receipt: 0.9, other: 0.1 });
    expect(selectLabels(result, config)).toEqual(["Receipt"]);
  });
});
