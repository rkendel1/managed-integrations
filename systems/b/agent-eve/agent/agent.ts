import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

/**
 * System B's repair proposer. It has no tools: System B hands it a bounded, sanitised task (the incident, the
 * engine's current specification, the provider's published type) and it returns a structured candidate.
 * It cannot read credentials, call providers, change state, or approve anything: System B validates every
 * candidate deterministically and a person decides whether it is released.
 *
 * Model: Anthropic directly (MI_REPAIR_ANTHROPIC_KEY); replaceable without touching System B.
 */
export default defineAgent({
  defaultTools: false,
  model: anthropic(process.env.MI_REPAIR_MODEL ?? "claude-haiku-5-5", { apiKey: () => process.env.MI_REPAIR_ANTHROPIC_KEY ?? "" }),
});
