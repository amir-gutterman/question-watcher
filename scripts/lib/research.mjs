// Research step, powered by Claude Haiku. One call per question: a single
// web search (max_uses: 1, tool_choice: "any" forces it to actually search
// rather than answer from memory) producing a strict "No" / "Yes: <detail>"
// answer. Because the answer format is fixed, a plain text comparison is
// enough to detect a meaningful change - see the "changed" computation
// below - so no separate semantic-comparison call is needed. This is the
// seam where the AI provider or prompt strategy can be swapped later
// without touching the rest of check.mjs - see README "Swapping the search
// provider".

import Anthropic from "@anthropic-ai/sdk";
import { PROMPT_VERSION, RESEARCH_SYSTEM_PROMPT, buildResearchUserPrompt } from "./prompts.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

export class ResearchRefusedError extends Error {
  constructor(category) {
    super(`Claude declined to research this question (category: ${category ?? "unspecified"})`);
    this.name = "ResearchRefusedError";
    this.category = category;
  }
}

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/** Concatenates the trailing text blocks (the final answer, after any
 * search) and collects { title, url } from web_search_tool_result blocks. */
function extractAnswerAndSources(response) {
  let lastNonTextIndex = -1;
  response.content.forEach((block, i) => {
    if (block.type !== "text") lastNonTextIndex = i;
  });
  const finalTextBlocks = response.content
    .slice(lastNonTextIndex + 1)
    .filter((block) => block.type === "text");

  const sources = [];
  const seen = new Set();
  for (const block of response.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item.type === "web_search_result" && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          sources.push({ title: item.title || item.url, url: item.url });
        }
      }
    }
  }

  const answer = finalTextBlocks.map((block) => block.text).join(" ").trim();
  // One web_search call still returns a full results page (multiple links) -
  // "just check one source" means recording only the top result, not every
  // link the search happened to surface.
  return { answer, sources: sources.slice(0, 1) };
}

function normalize(answer) {
  return (answer || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Researches one question and returns the structured result. The caller
 * (check.mjs) is responsible for the "first-ever check never counts as
 * changed" rule, since that depends on state this module doesn't hold.
 */
export async function research({ questionText, previousAnswer }) {
  console.log(JSON.stringify({ event: "research.start", questionText, promptVersion: PROMPT_VERSION }));

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 300,
    system: RESEARCH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildResearchUserPrompt({ questionText }) }],
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
    // Forces the model to actually call web_search instead of answering
    // from memory.
    tool_choice: { type: "any" },
  });

  if (response.stop_reason === "refusal") {
    throw new ResearchRefusedError(response.stop_details?.category ?? null);
  }

  const { answer, sources } = extractAnswerAndSources(response);
  if (!answer) {
    throw new Error(`Empty research response (stop_reason: ${response.stop_reason})`);
  }

  // The answer format is fixed ("No" / "Yes: <detail>"), so a plain
  // normalized comparison is a reliable, free way to detect a meaningful
  // change - no separate semantic-comparison call needed.
  const changed = previousAnswer !== null && normalize(answer) !== normalize(previousAnswer);
  const changeReason =
    previousAnswer === null
      ? "First check - establishing the baseline answer."
      : changed
        ? `Answer changed from "${previousAnswer}" to "${answer}".`
        : `No change - still "${answer}".`;

  const result = { answer, summary: answer, sources, changed, changeReason };
  console.log(JSON.stringify({ event: "research.done", changed: result.changed, sourceCount: sources.length }));
  return result;
}
