import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../../src/core/config";

describe("loadConfig", () => {
  it("returns the bundled config with 5 options and 2 flags", () => {
    const config = loadConfig();
    expect(Object.keys(config.category.options)).toHaveLength(5);
    expect(Object.keys(config.flags)).toHaveLength(2);
  });
});

describe("parseConfig", () => {
  const valid = () => structuredClone(loadConfig()) as unknown as Record<string, unknown>;

  it("rejects secondary > primary", () => {
    const raw = valid();
    (raw.category as { thresholds: { secondary: number } }).thresholds.secondary = 0.9;
    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects a config missing a null-label option", () => {
    const raw = valid();
    const options = (raw.category as { options: Record<string, { label: string | null }> }).options;
    options.other.label = "Other";
    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects duplicate label names", () => {
    const raw = valid();
    const options = (raw.category as { options: Record<string, { label: string | null }> }).options;
    options.shipped.label = options.receipt.label;
    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects a threshold of 1.5", () => {
    const raw = valid();
    (raw.flags as Record<string, { threshold: number }>).action.threshold = 1.5;
    expect(() => parseConfig(raw)).toThrow();
  });

  it("rejects a non-object input", () => {
    expect(() => parseConfig("not an object")).toThrow();
  });
});
