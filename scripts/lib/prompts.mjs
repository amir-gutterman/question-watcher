// Prompt template for the research step, kept separate from the code that
// calls the API so the prompt can be iterated on without touching
// orchestration logic. Bump PROMPT_VERSION when the prompt changes
// meaningfully (it's logged with every run) so past behavior changes are
// traceable in the Action's run logs later.
//
// Deliberately minimal by design: every question here is a strict Yes/No
// question, answered from a single source on a cheap model. Constraining
// the answer to a fixed "No" / "Yes: <detail>" format means a plain text
// comparison is enough to detect a meaningful change - no separate semantic
// comparison call needed (that's what the old two-call design solved, back
// when answers were free-form paragraphs prone to wording variance). See
// research.mjs for the comparison logic.

export const PROMPT_VERSION = "2026-07-16.1";

export const RESEARCH_SYSTEM_PROMPT = `You answer simple Yes/No questions for a personal tracking tool.

Search the web ONCE, using the single most authoritative, relevant source you can find, and answer from that - do not search again unless that first source is genuinely inconclusive for this specific question.

Reply with ONLY one of these two forms - nothing else, no sources list, no explanation, no extra sentences:
- If the answer is no: reply with exactly the word "No"
- If the answer is yes: reply with "Yes" followed by a colon and a short clarifying detail, only if the question needs one to be useful (e.g. a date, a name, a specific fact) - e.g. "Yes: Season 4 premieres March 2027." If no extra detail is needed, just reply "Yes".`;

export function buildResearchUserPrompt({ questionText }) {
  return `Question: "${questionText}"\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;
}
