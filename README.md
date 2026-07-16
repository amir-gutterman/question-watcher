# Question Watcher

Monitors a list of free-form questions ("Has Company X released Product Y?"),
researches each one on the web on a schedule, and emails you only when there
is a **meaningful** change since the last check - not just different wording.

Runs entirely on **GitHub Pages + GitHub Actions**. There is no server to
host, no database to run, and no hosting cost: the static dashboard on Pages
talks directly to the GitHub API, and Actions does the research and email on
a schedule (or on demand).

**Live dashboard:** https://amir-gutterman.github.io/question-watcher/

## How it works

```
                       ┌─────────────────────────────┐
  You, in browser ────▶│  docs/index.html            │
                       │  (GitHub Pages, static)     │
                       └──────────────┬───────────────┘
                                      │ GitHub REST API
                                      │ (your personal access token)
                    ┌─────────────────┼─────────────────────┐
                    ▼                 ▼                     ▼
          questions.json      state.json (read)    workflow_dispatch
          settings.json         (per question:              │
          (read + write)         answer, status,             │
                                  history)                    │
                                                               ▼
                                                  .github/workflows/
                                                  question-watch.yml
                                                  (GitHub Actions)
                                                               │
                                             scripts/check.mjs │
                                                               ├──▶ Claude API (research + web search)
                                                               ├──▶ Gmail SMTP (email, only if changed)
                                                               └──▶ commits state.json back to the repo
```

- **`docs/index.html`** - a single static page, no build step, no
  framework. You paste a GitHub **fine-grained personal access token**
  (stored only in your browser's `localStorage`) that lets the page read and
  write `questions.json`/`settings.json` directly via the GitHub Contents
  API, and trigger the Actions workflow on demand ("Check now" /
  "Check all now") via `workflow_dispatch`.
- **`.github/workflows/question-watch.yml`** - runs `scripts/check.mjs`
  every hour (cheap no-op most hours - see "Scheduling" below) and whenever
  triggered manually from the page. Commits `state.json` back to the repo
  with the results.
- **`scripts/check.mjs`** - the actual work: reads `questions.json` /
  `state.json` / `settings.json`, researches whatever is due via
  [`scripts/lib/research.mjs`](scripts/lib/research.mjs) (one cheap Claude
  Haiku call per question, one web search, a strict "No" / "Yes: &lt;detail&gt;"
  answer), updates `state.json`, and emails a batch of whatever changed via
  [`scripts/lib/notify.mjs`](scripts/lib/notify.mjs) (Gmail SMTP).
- **The repo is the database.** `questions.json` (your questions),
  `state.json` (current answer + status + history per question, written by
  Actions), and `settings.json` (email/timezone/schedule, written by the
  page) are plain JSON files committed to the repo.

## Why there's no separate "Search API key"

Claude's built-in web search tool (`web_search_20260209`) does the
searching, result filtering, and citation gathering server-side as part of
the same API call that does the summarizing and change-detection. One
`ANTHROPIC_API_KEY` secret covers research + comparison + email copy -
no separate search provider to sign up for. See "Swapping the search
provider" below if you'd rather plug in a dedicated one.

## Setup

### 1. Fork or use this repo

If this is your own copy, update `OWNER`/`REPO` at the top of
[`docs/index.html`](docs/index.html)'s `<script>` block to match your
GitHub username/repo name.

### 2. Enable GitHub Pages

Repo **Settings → Pages → Build and deployment → Source: Deploy from a
branch → Branch: `main`, folder: `/docs`**. Your dashboard will be live at
`https://<your-username>.github.io/<repo-name>/` within a minute or two.

### 3. Add repository secrets

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | From [console.anthropic.com](https://console.anthropic.com/) |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-opus-4-8` if unset |
| `GMAIL_ADDRESS` | yes, to send email | The Gmail address to send from |
| `GMAIL_APP_PASSWORD` | yes, to send email | A 16-character Gmail App Password - see "Email configuration" below |
| `EMAIL_FROM_NAME` | no | Display name on outgoing emails. Defaults to `Question Watcher` |

### 4. Create a GitHub personal access token for the dashboard

The static page needs its own token to read/write `questions.json` /
`settings.json` and to trigger checks - separate from the secrets above,
which only Actions uses.

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   (or click "Create one" in the token bar on the page).
2. **Repository access:** "Only select repositories" → this repo.
3. **Permissions:** `Contents: Read and write`, `Actions: Read and write`.
4. Generate, copy the token, and paste it into the token bar at the top of
   the dashboard the first time you load it. It's stored only in your
   browser's `localStorage` - never sent anywhere except the GitHub API.
5. Saving it also triggers your browser's native "save password?" prompt
   (via the Credential Management API where supported, e.g. Chrome/Edge).
   Accepting it means a synced browser signed into the same account on
   another device (e.g. your phone) can often retrieve it automatically
   instead of asking you to paste the token again.

### 5. Add your first question

Open the dashboard, paste your token, click **"+ Add question"**. That's it
- it's saved straight to `questions.json` in the repo.

## Email configuration

Sent via Gmail's SMTP server using an account **App Password** - no sending
domain to verify, works with any Gmail account.

1. Enable **2-Step Verification** on the Google account you want to send
   from, if it isn't already: [myaccount.google.com/security](https://myaccount.google.com/security).
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   (Google occasionally moves this - if the link doesn't work, search "App
   passwords" from the Google Account search bar).
3. Under "App name," enter something like `Question Watcher` and click
   **Create**. Google shows a 16-character password once - copy it.
4. Set the `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD` repository secrets (see
   above).
5. Set your recipient address from the **Settings** dialog on the dashboard
   (writes to `settings.json`).

## Scheduling

GitHub Actions cron schedules are fixed at the workflow-file level and
always UTC - they can't be edited live from a web page without giving the
page write access to workflow files, and there's no per-workflow timezone
support. So instead of encoding your schedule directly in the cron
expression, the workflow runs **every hour** (cheap - a few seconds when
there's nothing due), and `scripts/check.mjs` itself decides whether *this*
tick falls in your configured weekly slot by reading `scheduleDayOfWeek` /
`scheduleHour` / `timezone` from `settings.json` (all editable from the
Settings dialog on the dashboard, no code changes needed). A
`meta.lastWeeklyRunAt` marker in `state.json` stops it from double-firing if
two ticks land in the same matching hour.

**Known limitation:** GitHub Actions scheduled workflows aren't guaranteed
to fire exactly on time - GitHub documents that scheduled runs can be
delayed under load, especially right at the top of the hour. The workflow's
cron is intentionally set to fire at `:07` (off the top of the hour) to
reduce this, but expect your weekly check within the hour rather than to
the exact minute. Use **"Check now"** / **"Check all now"** on the
dashboard any time you don't want to wait.

## Detecting change: a constrained answer format, not semantic comparison

Every question here is a strict Yes/No question, and the model is instructed
(see [`scripts/lib/prompts.mjs`](scripts/lib/prompts.mjs)) to reply with only
one of two forms: exactly `"No"`, or `"Yes: <short detail>"` (e.g. `"Yes:
Season 4 premieres March 2027."`). Because the format is fixed, a plain
normalized text comparison (see `research.mjs`) is enough to catch a real
change - the wording-variance problem that would normally require a
semantic-comparison LLM call ("no release date" vs. "still no release
date") doesn't come up when the model isn't allowed to phrase things
differently between checks. This also means no second API call is needed
just to decide changed/unchanged - one cheap call does the whole thing.
A question's very first check never emails (there's nothing to compare
against yet) - it just establishes the baseline answer.

If your questions need free-form answers instead of Yes/No (e.g. "What is
the release date?"), you'd want to bring back a semantic-comparison step -
see git history before this change for the two-call design that did that
via a follow-up structured-JSON call.

If you want to tune the answer format or research behavior, edit the system
prompt in `scripts/lib/prompts.mjs` - bump `PROMPT_VERSION` when you do,
since it's logged with every run (visible in the Action's run logs) and lets
you correlate behavior changes with prompt changes later. Nothing else needs
to change for a prompt edit to take effect.

## Keeping this cheap

Two choices keep the per-check cost low:

- **Model**: defaults to `claude-haiku-4-5` (via `ANTHROPIC_MODEL`), the
  cheapest current Claude model - plenty for a Yes/No lookup, no need for a
  larger model's deeper reasoning.
- **Search depth**: `max_uses: 1` on the web search tool caps the model to a
  single search call per question (`tool_choice: "any"` forces it to
  actually search rather than answer from memory, but it can't search
  again after that). One search can still return multiple links in its
  results page - only the top one is kept in `sources`.

Together these took a single check from tens of cents (a thorough, 20-30
source research paragraph on Opus) down to a small fraction of a cent. If
you switch to a larger model or loosen `max_uses`, expect the cost to scale
accordingly - see `scripts/lib/research.mjs`.

## Data model

Three JSON files at the repo root, all committed to git:

- **`questions.json`** - array of `{ id, text, enabled, createdAt }`. Owned
  by the dashboard (read + written by the page).
- **`state.json`** - `{ meta: { lastWeeklyRunAt }, questions: { [id]: {
  lastCheckedAt, lastUpdateAt, currentAnswer, currentSummary, status,
  lastError, history } } }`. Owned by Actions (`scripts/check.mjs` writes
  it; the page only reads it). `history` is capped at the 20 most recent
  checks per question.
- **`settings.json`** - `{ notifyEmail, timezone, scheduleDayOfWeek,
  scheduleHour }`. Owned by the dashboard.

## Logging

Every run, search, email send, and error is logged as structured JSON to
stdout - visible in the **Actions tab → Question Watch → (a run) → check**
step logs. `event` field values include `check.start`, `check.done`,
`check.error`, `research.start`, `research.done`, `notify.email.sent`,
`notify.channel_failed`, `scheduler.not_due`.

## Running locally (testing only)

The deployed workflow never reads a local `.env` file - it uses GitHub
Secrets. But you can test `scripts/check.mjs` locally against the real APIs
before relying on it:

```bash
npm install
cp .env.example .env    # fill in ANTHROPIC_API_KEY, GMAIL_ADDRESS, GMAIL_APP_PASSWORD

# Check one question by id (see questions.json for ids):
node scripts/check.mjs q_abc123

# Check every enabled question now (same as "Check all now" on the page):
node scripts/check.mjs
```

This writes straight to your local `questions.json`/`state.json` - commit
or discard those changes as you like before pushing.

## Extending Question Watcher

### Adding a new notification channel (Slack, Telegram, WhatsApp, push, RSS)

1. Write a `send(updates, settings)` function in
   [`scripts/lib/notify.mjs`](scripts/lib/notify.mjs), following the shape
   of the existing `sendEmail`.
2. Add it to the `channels` array in `notifyUpdates()`.
3. Add whatever config it needs (e.g. a webhook URL) as a field in
   `settings.json`, and expose it in the Settings dialog in
   `docs/index.html`.

Nothing in `check.mjs` or the workflow needs to change - `notifyUpdates()`
fans out to every configured channel and logs+swallows per-channel failures
so one broken channel never blocks another or fails the whole Action run.

### Other extension points

- **Daily/hourly schedules, or per-question frequency**: the workflow
  already ticks hourly; `scheduleDayOfWeek`/`scheduleHour` in
  `settings.json` could become per-question fields instead of global ones,
  with `check.mjs` gating each question independently.
- **Multiple users / shared question lists / authentication**: the GitHub
  PAT model is inherently single-user (whoever holds a token with write
  access to the repo can manage questions). Multi-user would mean a real
  backend and moving away from the repo-as-database pattern - a bigger
  architectural change than the other extensions here.
- **AI-generated follow-up questions**: a natural extension of
  `scripts/lib/research.mjs` - after a meaningful change is found, a
  follow-up Claude call could suggest related questions to watch, surfaced
  as suggestions on the dashboard rather than auto-added.
- **Swapping the search provider**: replace the `web_search_20260209` tool
  call in [`scripts/lib/research.mjs`](scripts/lib/research.mjs) with a
  dedicated search API call (Tavily, Brave, etc.) feeding results into a
  follow-up Claude call for summarization/comparison - the rest of the app
  (state shape, notification) is unaffected.

## Project structure

```
docs/
  index.html               Static dashboard (GitHub Pages). GitHub PAT in
                            localStorage, CRUD via Contents API, triggers
                            checks via workflow_dispatch.
scripts/
  check.mjs                 Actions job entrypoint: reads the JSON files,
                             runs due checks, writes state.json, emails.
  lib/
    research.mjs             One cheap Haiku call + single web search + text-diff change detection
    prompts.mjs               System prompt for the strict Yes/No answer format
    notify.mjs                 Notification fan-out (Gmail SMTP today)
    emailTemplates.mjs         Email subject/HTML/text builders
.github/workflows/
  question-watch.yml        Hourly schedule + workflow_dispatch, runs
                             check.mjs, commits state.json.
questions.json               Your questions (id, text, enabled, createdAt)
state.json                   Per-question answer/status/history (Actions writes this)
settings.json                Email/timezone/schedule (dashboard writes this)
```
