// Research step, powered by Claude. Two calls per question:
//   1. A web-search-forced call (tool_choice: "any" guarantees the model
//      actually searches instead of answering from memory) that produces a
//      plain-text answer and citations.
//   2. A cheap text-only structured-JSON call (no tools) that turns that
//      answer into the semantic changed/unchanged decision.
// Combining web_search with output_config.format json_schema in one call
// proved unreliable in production (empty sources, garbled repeated-word
// text, and the tool being skipped entirely - all observed live, with the
// same prompt, across different runs). Splitting the concerns removes that
// interaction. This is the seam where the AI provider or prompt strategy can
// be swapped later without touching the rest of check.mjs - see README
// "Swapping the search provider".

import Anthropic from "@anthropic-ai/sdk";
import {
  PROMPT_VERSION,
  DECISION_OUTPUT_SCHEMA,
  DECISION_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
  buildDecisionPrompt,
  buildResearchUserPrompt,
} from "./prompts.mjs";

const MAX_PAUSE_RESUMES = 3;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

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

/** Concatenates text blocks (web search citations can split the answer into
 * several) and collects { title, url } from web_search_tool_result blocks. */
function extractAnswerAndSources(response) {
  // Between tool calls, Claude often writes intermediate narration text
  // blocks ("Let me search more specifically for...") - only the trailing
  // run of text blocks, after the last tool-result block, is the actual
  // final answer. Collecting every text block (including mid-search
  // narration) was a real bug that leaked process commentary into the
  // user-facing answer.
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

  const textParts = finalTextBlocks.map((block) => block.text);

  return { answer: textParts.join(" ").trim(), sources };
}

async function researchAnswer({ questionText, previousAnswer, previousCheckedAt }) {
  const messages = [
    { role: "user", content: buildResearchUserPrompt({ questionText, previousAnswer, previousCheckedAt }) },
  ];

  let response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: RESEARCH_SYSTEM_PROMPT,
    messages,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
    // Forces the model to actually call web_search instead of answering
    // from memory - only needed on the first turn to kick off the search.
    tool_choice: { type: "any" },
  });

  // Server-side tools run in an internal loop capped at 10 iterations. If
  // that cap is hit mid-research, the API returns stop_reason "pause_turn" -
  // resend to let it continue where it left off.
  let resumes = 0;
  while (response.stop_reason === "pause_turn" && resumes < MAX_PAUSE_RESUMES) {
    resumes += 1;
    console.log(JSON.stringify({ event: "research.pause_turn_resume", resumes }));
    messages.push({ role: "assistant", content: response.content });
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: RESEARCH_SYSTEM_PROMPT,
      messages,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
    });
  }

  if (response.stop_reason === "refusal") {
    throw new ResearchRefusedError(response.stop_details?.category ?? null);
  }

  const { answer, sources } = extractAnswerAndSources(response);
  if (!answer) {
    throw new Error(`Empty research response (stop_reason: ${response.stop_reason})`);
  }

  return { answer, sources };
}

async function decideChange({ questionText, previousAnswer, newAnswer }) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: DECISION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildDecisionPrompt({ questionText, previousAnswer, newAnswer }) }],
    output_config: {
      format: { type: "json_schema", schema: DECISION_OUTPUT_SCHEMA },
    },
  });

  if (response.stop_reason === "refusal") {
    throw new ResearchRefusedError(response.stop_details?.category ?? null);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error(`No text content in decision response (stop_reason: ${response.stop_reason})`);
  }
  return JSON.parse(textBlock.text);
}

/**
 * Researches one question and returns the structured result. The caller
 * (check.mjs) is responsible for the "first-ever check never counts as
 * changed" rule, since that depends on state this module doesn't hold -
 * though the prompts already steer the model toward false in that case too,
 * as a second line of defense.
 */
export async function research({ questionText, previousAnswer, previousCheckedAt }) {
  console.log(JSON.stringify({ event: "research.start", questionText, promptVersion: PROMPT_VERSION }));

  const { answer, sources } = await researchAnswer({ questionText, previousAnswer, previousCheckedAt });
  const decision = await decideChange({ questionText, previousAnswer, newAnswer: answer });

  const result = {
    answer,
    summary: decision.summary,
    sources,
    changed: decision.changed,
    changeReason: decision.changeReason,
  };

  console.log(
    JSON.stringify({ event: "research.done", changed: result.changed, sourceCount: sources.length }),
  );
  return result;
}
