// Research step: one Claude API call (with its built-in web search tool)
// per question, producing a structured answer + semantic change judgment.
// This is the seam where the AI provider or prompt strategy can be swapped
// later without touching the rest of check.mjs.

import Anthropic from "@anthropic-ai/sdk";
import {
  PROMPT_VERSION,
  RESEARCH_OUTPUT_SCHEMA,
  RESEARCH_SYSTEM_PROMPT,
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

async function callClaude(messages) {
  return getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: RESEARCH_SYSTEM_PROMPT,
    messages,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
    output_config: {
      format: { type: "json_schema", schema: RESEARCH_OUTPUT_SCHEMA },
    },
  });
}

/**
 * Researches one question and returns the structured result. The caller
 * (check.mjs) is responsible for the "first-ever check never counts as
 * changed" rule, since that depends on state this module doesn't hold.
 */
export async function research({ questionText, previousAnswer, previousCheckedAt }) {
  console.log(
    JSON.stringify({ event: "research.start", questionText, promptVersion: PROMPT_VERSION }),
  );

  const messages = [
    { role: "user", content: buildResearchUserPrompt({ questionText, previousAnswer, previousCheckedAt }) },
  ];

  let response = await callClaude(messages);

  // Server-side tools (web_search) run in an internal loop capped at 10
  // iterations. If that cap is hit mid-research, the API returns
  // stop_reason "pause_turn" - resend to let it continue where it left off.
  let resumes = 0;
  while (response.stop_reason === "pause_turn" && resumes < MAX_PAUSE_RESUMES) {
    resumes += 1;
    console.log(JSON.stringify({ event: "research.pause_turn_resume", resumes }));
    messages.push({ role: "assistant", content: response.content });
    response = await callClaude(messages);
  }

  if (response.stop_reason === "refusal") {
    throw new ResearchRefusedError(response.stop_details?.category ?? null);
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error(`No text content in research response (stop_reason: ${response.stop_reason})`);
  }

  const result = JSON.parse(textBlock.text);
  console.log(
    JSON.stringify({ event: "research.done", changed: result.changed, sourceCount: result.sources.length }),
  );
  return result;
}
