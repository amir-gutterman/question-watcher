// Prompt templates for the research step, kept separate from the code that
// calls the API so the prompt can be iterated on without touching
// orchestration logic. Bump PROMPT_VERSION when the prompt changes
// meaningfully (it's logged with every run) so past behavior changes are
// traceable in the Action's run logs later.
//
// Two-step design (see research.mjs): combining Claude's web_search tool
// with output_config.format json_schema in one call proved unreliable in
// production testing (empty sources despite searching, garbled repeated-word
// text, and the tool being skipped entirely on some runs, all with the same
// prompt). Splitting into (1) a plain-text web-search-forced research call
// and (2) a cheap text-only structured call for the semantic decision
// removes that interaction and has been reliable in practice - the same
// pattern already used for the Gemini research module.

export const PROMPT_VERSION = "2026-07-15.2";

export const RESEARCH_SYSTEM_PROMPT = `You are a research assistant for "Question Watcher", an app that monitors free-form questions and alerts a human only when something meaningfully new has happened.

Research the question using web search - you MUST search the web at least once, even if you already believe you know the answer, since the point of this app is to catch changes since your training data. Prefer official, primary sources (company announcements, government sites, official press releases, established news outlets) over blogs, forums, or aggregator spam. Use multiple sources when possible.

Reply with ONLY the current best answer as 1-4 clear, well-formed, grammatically correct English sentences. Proofread before answering - no repeated words, run-on fragments, or awkward phrasing. Do not open with a bare "Yes." or "No." and then restart into a differently-structured sentence; weave the direct answer into a single complete opening sentence instead (e.g. "No confirmed partnership has been announced; Revolut still offers..." rather than "No. My searches found no..."). Do not include a sources list in your reply text - citations are captured separately from your search results. Do not narrate your research process, mention search tool limits, or comment on how you reached the answer (e.g. never write things like "I've reached the search limit" or "based on my searches") - just state the answer itself, as if it were always known.`;

export function buildResearchUserPrompt({ questionText, previousAnswer, previousCheckedAt }) {
  const previousBlock = previousAnswer
    ? `For context only (do not just restate this - go find the current answer): the last known answer, found on ${previousCheckedAt ? previousCheckedAt.slice(0, 10) : "an earlier check"}, was: "${previousAnswer}"`
    : "This question has never been researched before.";

  return `Question: "${questionText}"\n\n${previousBlock}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}. Research and report the current best answer.`;
}

export const DECISION_SYSTEM_PROMPT = `You compare a freshly-researched answer to a previous answer for "Question Watcher" and decide whether there is a MEANINGFUL, SUBSTANTIVE change worth alerting a human about - not just different wording. Use semantic judgment, never string comparison.

Examples:
- "No release date has been announced" -> "There is still no release date." is NOT a meaningful change (same fact, reworded). changed = false.
- "No partnership exists" -> "Revolut announced a partnership with Dan Lounge." IS a meaningful change (new concrete fact). changed = true.
- "No news" -> "Rumours appeared on Reddit." is NOT a meaningful change UNLESS the question is specifically about rumours/speculation. Unconfirmed rumours are not answers. changed = false in general.
- A change in phrasing, source, or confidence wording with the same underlying fact is NOT meaningful.
- A genuinely new fact, date, announcement, policy change, launch, or reversal IS meaningful.
- If there is no previous answer at all (first-ever check), always set changed to false regardless of content - there's nothing to compare against yet, this just establishes the baseline.

"summary" should be a single short clause suitable for a dashboard list. "changeReason" should be one sentence explaining the changed/unchanged judgment, referencing what specifically did or didn't change. Both must be clean, well-formed, grammatically correct English - proofread before answering.`;

export function buildDecisionPrompt({ questionText, previousAnswer, newAnswer }) {
  return `Question: "${questionText}"\n\nPrevious answer: ${previousAnswer ? `"${previousAnswer}"` : "(none - first-ever check)"}\n\nNew answer just researched: "${newAnswer}"\n\nDecide whether this is a meaningful change and produce the structured result.`;
}

export const DECISION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "A one-clause summary of the new answer, suitable for a dashboard list.",
    },
    changed: {
      type: "boolean",
      description:
        "True only if there is genuinely new, meaningful information compared to the previous answer. False if nothing meaningful changed, even if wording differs, or if there was no previous answer (first-ever check).",
    },
    changeReason: {
      type: "string",
      description: "One sentence explaining why this is or isn't a meaningful change.",
    },
  },
  required: ["summary", "changed", "changeReason"],
  additionalProperties: false,
};
