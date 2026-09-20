import { z } from "zod";
import rawLabelsConfig from "../../config/labels.json";
import type { LabelConfig } from "./types";

const criteriaSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

const categoryOptionSchema = z.object({
  label: z.string().min(1).nullable(),
  criteria: criteriaSchema,
});

const flagConfigSchema = z.object({
  label: z.string().min(1),
  threshold: z.number().min(0).max(1),
  instructions: z.string(),
  criteria: criteriaSchema,
});

const labelConfigSchema = z
  .object({
    model: z.string().min(1),
    body: z.object({ maxChars: z.number().min(500) }),
    category: z.object({
      instructions: z.string(),
      maxLabels: z.number().min(1),
      thresholds: z.object({
        primary: z.number().min(0).max(1),
        secondary: z.number().min(0).max(1),
      }),
      options: z.record(z.string(), categoryOptionSchema),
    }),
    flags: z.record(z.string(), flagConfigSchema),
  })
  .superRefine((config, ctx) => {
    // Cross-field rules that a plain shape schema cannot express.
    if (config.category.thresholds.secondary > config.category.thresholds.primary) {
      ctx.addIssue({
        code: "custom",
        message: "category.thresholds.secondary must be <= category.thresholds.primary",
        path: ["category", "thresholds", "secondary"],
      });
    }

    const options = Object.values(config.category.options);
    if (!options.some((option) => option.label === null)) {
      ctx.addIssue({
        code: "custom",
        message: "category.options must include at least one option with label: null",
        path: ["category", "options"],
      });
    }

    // Label names must be unique across category options and flags, since
    // they all become Gmail labels applied to the same message.
    const seen = new Set<string>();
    for (const name of options.map((option) => option.label).filter((label) => label !== null)) {
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate label name: ${name}`,
          path: ["category", "options"],
        });
      }
      seen.add(name);
    }
    for (const flag of Object.values(config.flags)) {
      if (seen.has(flag.label)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate label name: ${flag.label}`,
          path: ["flags"],
        });
      }
      seen.add(flag.label);
    }
  });

export function parseConfig(raw: unknown): LabelConfig {
  return labelConfigSchema.parse(raw);
}

let cachedConfig: LabelConfig | undefined;

export function loadConfig(): LabelConfig {
  if (!cachedConfig) {
    cachedConfig = parseConfig(rawLabelsConfig);
  }
  return cachedConfig;
}
