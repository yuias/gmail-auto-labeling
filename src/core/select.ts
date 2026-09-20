import type { ClassificationResult, LabelConfig } from "./types";

// Categories compete for a limited number of slots; flags are independent
// judgments and are added on their own thresholds, outside that limit.
export function selectLabels(result: ClassificationResult, config: LabelConfig): string[] {
  const labels: string[] = [];
  const { maxLabels, thresholds, options } = config.category;

  // An option with a null label (the catch-all) is never applied and never
  // occupies a slot, so it is dropped before ranking.
  const ranked = Object.entries(options)
    .filter(([, option]) => option.label !== null)
    .map(([key, option]) => ({
      label: option.label as string,
      p: result.category.probabilities[key] ?? 0,
    }))
    .sort((a, b) => b.p - a.p);

  const chosenIsOther = options[result.category.choice]?.label == null;
  if (!chosenIsOther && ranked[0] && ranked[0].p >= thresholds.primary) {
    labels.push(ranked[0].label);
    for (let i = 1; i < maxLabels && i < ranked.length; i++) {
      if (ranked[i].p >= thresholds.secondary) labels.push(ranked[i].label);
    }
  }

  for (const [id, flag] of Object.entries(config.flags)) {
    if ((result.flags[id] ?? 0) >= flag.threshold) labels.push(flag.label);
  }

  return labels;
}
