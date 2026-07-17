#!/usr/bin/env node
// The single entrypoint the GitHub Actions workflow runs (on the hourly
// schedule, and on manual "Check now" via workflow_dispatch). Reads the
// repo's JSON files as the database, researches whatever is due, writes the
// results back to state.json (the workflow step commits it), and emails a
// batch of whatever changed.
//
// Local testing: `node scripts/check.mjs [questionId]` - with no argument,
// checks every enabled question; with an id, checks just that one,
// regardless of its enabled flag (matches "Check now" from the UI).

import { readFile, writeFile } from "node:fs/promises";
import { research, ResearchRefusedError } from "./lib/research.mjs";
import { notifyUpdates } from "./lib/notify.mjs";

const QUESTIONS_PATH = "questions.json";
const STATE_PATH = "state.json";
const SETTINGS_PATH = "settings.json";

const HISTORY_LIMIT = 20;
// A scheduled tick only does real work once per matching weekly slot. This
// window just needs to be shorter than a week and longer than the gap
// between two hourly ticks, so accidental double-ticks in the same hour
// don't double-run.
const WEEKLY_DEDUPE_WINDOW_HOURS = 20;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

/**
 * Reads workflow_dispatch inputs from the Actions event payload. Outside of
 * Actions (GITHUB_ACTIONS unset - i.e. running locally via `node
 * scripts/check.mjs [questionId]`), simulates a manual dispatch from argv so
 * the script is testable without faking an Actions event file.
 */
async function getDispatchInputs() {
  if (!process.env.GITHUB_ACTIONS) {
    return { question_id: process.argv[2] || "" };
  }
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") return null;
  if (!process.env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf-8"));
  return event.inputs ?? {};
}

/**
 * True if `now` falls in the hour matching settings.scheduleDayOfWeek /
 * scheduleHour, interpreted in settings.timezone.
 */
function isDueBySchedule(settings, now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timezone || "UTC",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);

  const weekdayStr = parts.find((p) => p.type === "weekday").value;
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayStr);

  return weekdayIndex === settings.scheduleDayOfWeek && hour === settings.scheduleHour;
}

function pushHistory(entry, list) {
  const next = [entry, ...list];
  return next.slice(0, HISTORY_LIMIT);
}

/** Anything other than a bare "No" counts as answered - matches the
 * dashboard's own parseAnswer() so archiving and display agree. */
function isYesAnswer(answer) {
  return !/^no$/i.test((answer || "").trim());
}

/**
 * Researches one question, updates `state.questions[id]` in place, and
 * returns a QuestionUpdate if the check found a meaningful change (email-
 * worthy) - or null otherwise. Never throws: failures are recorded on the
 * question's state instead, so one bad question can't take down the batch.
 *
 * Also auto-pauses the question (question.enabled = false, mutated in
 * place so the caller can persist questions.json) the moment its answer
 * *becomes* "Yes" - once answered, there's nothing left to watch for by
 * default. Only fires on the transition (not-yet-Yes -> Yes), so manually
 * re-enabling an already-answered question to keep watching it sticks -
 * this won't re-pause it on every subsequent check that's still Yes.
 */
async function checkOne(question, state) {
  const prior = state.questions[question.id] ?? {
    lastCheckedAt: null,
    lastUpdateAt: null,
    currentAnswer: null,
    currentSummary: null,
    status: "PENDING",
    lastError: null,
    history: [],
  };

  console.log(JSON.stringify({ event: "check.start", questionId: question.id, text: question.text }));

  const now = new Date().toISOString();

  try {
    const result = await research({
      questionText: question.text,
      previousAnswer: prior.currentAnswer,
      previousCheckedAt: prior.lastCheckedAt,
    });

    // First-ever check: nothing to compare against, so this establishes the
    // baseline rather than counting as a "change" worth emailing about.
    const isFirstCheck = prior.currentAnswer === null;
    const changed = isFirstCheck ? false : result.changed;

    state.questions[question.id] = {
      lastCheckedAt: now,
      lastUpdateAt: changed ? now : prior.lastUpdateAt,
      currentAnswer: result.answer,
      currentSummary: result.summary,
      status: changed ? "UPDATED" : "UNCHANGED",
      lastError: null,
      history: pushHistory(
        {
          checkedAt: now,
          answer: result.answer,
          summary: result.summary,
          sources: result.sources,
          changed,
          changeReason: result.changeReason,
          errorMessage: null,
        },
        prior.history,
      ),
    };

    console.log(JSON.stringify({ event: "check.done", questionId: question.id, changed }));

    const wasYesBefore = prior.currentAnswer !== null && isYesAnswer(prior.currentAnswer);
    const isYesNow = isYesAnswer(result.answer);
    if (isYesNow && !wasYesBefore && question.enabled) {
      question.enabled = false;
      console.log(JSON.stringify({ event: "check.auto_paused", questionId: question.id }));
    }

    if (!changed) return null;

    return {
      questionId: question.id,
      questionText: question.text,
      previousAnswer: prior.currentAnswer,
      newAnswer: result.answer,
      changeReason: result.changeReason,
      sources: result.sources,
      foundAt: now,
    };
  } catch (err) {
    const message =
      err instanceof ResearchRefusedError ? err.message : `Research failed: ${err.message}`;

    console.error(JSON.stringify({ event: "check.error", questionId: question.id, error: message }));

    state.questions[question.id] = {
      ...prior,
      lastCheckedAt: now,
      status: "ERROR",
      lastError: message,
      history: pushHistory(
        {
          checkedAt: now,
          answer: "",
          summary: "",
          sources: [],
          changed: false,
          changeReason: "Check failed before an answer could be produced.",
          errorMessage: message,
        },
        prior.history,
      ),
    };

    return null;
  }
}

async function main() {
  const questions = await readJson(QUESTIONS_PATH, []);
  const state = await readJson(STATE_PATH, { meta: { lastWeeklyRunAt: null }, questions: {} });
  const settings = await readJson(SETTINGS_PATH, {
    notifyEmail: "",
    timezone: "UTC",
    scheduleDayOfWeek: 1,
    scheduleHour: 9,
  });

  const dispatchInputs = await getDispatchInputs();
  const isManualRun = dispatchInputs !== null;
  const manualQuestionId = dispatchInputs?.question_id?.trim() || null;

  let toCheck;
  if (isManualRun && manualQuestionId) {
    // "Check now" for a single question - runs regardless of enabled, since
    // it's an explicit user action.
    const question = questions.find((q) => q.id === manualQuestionId);
    if (!question) {
      console.error(JSON.stringify({ event: "check.question_not_found", questionId: manualQuestionId }));
      process.exitCode = 1;
      return;
    }
    toCheck = [question];
  } else if (isManualRun) {
    // Manual "check all now" - every enabled question, right now.
    toCheck = questions.filter((q) => q.enabled);
  } else {
    // Scheduled tick - only do real work in the hour matching the
    // configured weekly schedule, and only once per matching slot.
    const now = new Date();
    const due = isDueBySchedule(settings, now);
    const lastRun = state.meta.lastWeeklyRunAt ? new Date(state.meta.lastWeeklyRunAt) : null;
    const recentlyRan = lastRun && now - lastRun < WEEKLY_DEDUPE_WINDOW_HOURS * 60 * 60 * 1000;

    if (!due || recentlyRan) {
      console.log(JSON.stringify({ event: "scheduler.not_due", due, recentlyRan }));
      return;
    }

    state.meta.lastWeeklyRunAt = now.toISOString();
    toCheck = questions.filter((q) => q.enabled);
  }

  console.log(JSON.stringify({ event: "check.batch_start", count: toCheck.length, isManualRun }));

  const enabledBefore = new Map(questions.map((q) => [q.id, q.enabled]));
  const updates = [];
  for (const question of toCheck) {
    const update = await checkOne(question, state);
    if (update) updates.push(update);
  }

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

  // checkOne() auto-pauses a question in place (question.enabled = false)
  // the moment its answer becomes "Yes" - persist that if it happened.
  const questionsChanged = questions.some((q) => enabledBefore.get(q.id) !== q.enabled);
  if (questionsChanged) {
    await writeFile(QUESTIONS_PATH, JSON.stringify(questions, null, 2) + "\n");
    console.log(JSON.stringify({ event: "check.questions_updated" }));
  }

  await notifyUpdates(updates, settings);

  console.log(
    JSON.stringify({ event: "check.batch_done", count: toCheck.length, updateCount: updates.length }),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "check.fatal", error: err.message }));
  process.exitCode = 1;
});
