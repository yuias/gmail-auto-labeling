// One JSON line per call, with `event` first so log lines are greppable and
// still valid JSON when piped through `jq`.
export function log(event: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
