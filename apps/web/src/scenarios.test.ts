import { describe, expect, it } from "vitest";
import { outcomeOf, runSpec } from "./outcome.js";
import { SCENARIOS } from "./scenarios.js";

/** M4 done-criterion: every guided scenario behaves as described, on the first try. */
describe.each(SCENARIOS.filter((s) => !s.crashTest))("$title", (scenario) => {
  it.each(scenario.steps.map((s) => [s.label, s] as const))("%s", (_, step) => {
    const r = runSpec(step.spec);
    expect(r.drained).toBe(true);
    expect(r.violation).toBeNull();
    expect(outcomeOf(r)).toBe(step.expect);
    if (step.spec.crashes.length) expect(r.crashes).toBe(step.spec.crashes.length);
  });
});
