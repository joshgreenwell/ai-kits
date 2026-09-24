# PR watch queue

Added September 24, 2026. `/reviews` holds a queue of pull requests to re-review. When the author of a watched PR pushes commits that change its diff, a background Claude session (Opus 5.5, medium effort) runs the `luumen-ai-pr-review` skill against the new head and posts a follow-up AI review. The follow-up review says which earlier findings are resolved and which are still open.

## Why the polling runs on the Mac

Vercel cannot start a Claude session on the owner's machine, and the review needs the owner's `gh` login, the skill, and the Luumen checkouts. So the site only holds the queue, and a runner on the Mac does the work:

- **The site** (`/reviews`, `personal_hub.pr_watches`) stores which PRs are watched, what the runner last saw, and the state of each review. The page has three actions: paste a URL and **Watch**, **Review now**, and **Stop**.
- **The runner** (`scripts/pr-watch.mjs`, run by launchd every 5 minutes) pulls the queue over a producer key and reads each PR through `gh`. When a rule below says a review is due, it starts `claude --bg`. The runner itself is plain code and spends no tokens.

A model that polled every five minutes would spend about 288 Opus turns a day on each PR just to learn that nothing changed. Here a model runs only when there is something to review.

```
browser ──session──▶ /api/pr-watches          (list, add, stop, review now)
runner  ──bearer───▶ /api/v1/pr-watches       (heartbeat + work list)
                     /api/v1/pr-watches/<id>  (report one watch)
runner  ──gh api───▶ GitHub                   (pull, files, reviews, compare)
runner  ──claude───▶ claude --bg --model claude-opus-5-5 --effort medium  (in ~/github/luumen-workspace)
```

## What counts as an update

`decide` in `scripts/pr-watch-core.mjs` makes every decision. It never touches the network, and `tests/pr-watch.test.ts` covers each branch.

1. **The baseline (first look).** The runner looks for the newest AI review that the `gh` login posted on the PR. A review counts as an AI review when its body opens with "AI review". That covers the skill's current header, `AI review by <model> of \`<sha>\`.`, and the older bold `**AI review — <model>.**` header. The reviewed SHA is the one the body names; if the body names none, it is the review's `commit_id` (the head when the review was submitted).
   - If there is no AI review, the watch starts from the current head. It does not review the PR until you press **Review now**.
   - If the AI review is at the head, the watch starts from there.
   - If the author has pushed since that review, a review starts on the first tick.
2. **The head is unchanged.** The runner makes no other GitHub reads.
3. **The head moved but the diff did not.** The fingerprint is a sha256 of file names, statuses, and only the added and removed lines, with hunk offsets left out. A rebase or a merge from the base moves the head without changing the fingerprint, so no review starts.
4. **Who pushed.** A commit counts as the author's when its author or committer login is the PR author. It also counts when it is a bot (`github-actions[bot]` pushes fixes for authors in the apiphani repos) or an email linked to no GitHub account. Only commits by another named person are ignored: a teammate, or you pushing a fix to someone else's PR. Missing a review costs more than running an extra one.
5. **Limits.** At most 2 reviews run at a time. A PR that is due for a review while both slots are busy shows "Queued" and starts on a later tick. A review that has not posted after 60 minutes is stopped and marked failed.
6. **Finishing.** A review is posted once a new AI review from the viewer appears. If the author pushed again while it ran, the next tick handles that push. If the session ends without posting, the watch shows the error and the `claude attach <id>` command. A merged or closed PR ends its watch. **Stop** never cancels a running review: that review still posts, and nothing new starts.

The prompt (`reviewPrompt`) tells the session:

- the owner authorized the post
- the compare range from the last reviewed SHA
- not to repeat open findings as new inline comments
- not to stop to ask questions
- not to switch branches in any existing checkout

## Safety

- The site never runs anything. It stores URLs, SHAs, notes and session ids.
  - URLs must be `https://github.com/<owner>/<repo>/pull/<n>`.
  - A 25-live-watch cap and a unique index make sure each PR has at most one live watch.
  - An advisory lock stops two pastes from racing past the cap or the unique index.
- The app role can only SELECT, INSERT and UPDATE the status columns. It cannot delete a watch or change which PR a watch points at (`tests/pr-watch-store.integration.test.ts`).
- The runner's key is a `pr-watch` producer key. `INGEST_KEYS_JSON` holds only its hash, and the key accepts only the two `/api/v1/pr-watches` routes (`proxy.ts`, `lib/auth.ts`).
- Double launches are prevented three ways:
  - A lock file serializes ticks.
  - `pr-watch-state.json` records a launch before the site acknowledges it, so the next tick re-reports that launch instead of starting a second session.
  - The store refuses a second `started` event.

## Setup

These steps need the owner's credentials and production access. Run them yourself.

1. Apply `supabase/migrations/20260924090000_pr_watches.sql` to production (`supabase db push --linked`).
2. Create the runner's key:
   ```bash
   node scripts/pr-watch.mjs keygen
   ```
   It saves the key to `~/.config/personal-hub/publish.json` under `producers["pr-watch"]` and prints only a hash entry. Merge that entry into `INGEST_KEYS_JSON` on Vercel.
3. Deploy the site.
4. Install the LaunchAgent:
   ```bash
   node scripts/pr-watch.mjs install
   ```
   It checks the key, `gh auth status`, `claude --version` and the workspace first, then loads `com.personal-observatory.pr-watch`. The agent runs this checkout's script in place, so moving or deleting the checkout stops it. Run `install` again after you move it.
5. Optional settings go in `~/.config/personal-hub/pr-watch.json`. These are the defaults:
   ```json
   { "model": "claude-opus-5-5", "effort": "medium", "permission_mode": "auto", "skill": "luumen-ai-pr-review",
     "workspace": "~/github/luumen-workspace", "max_concurrent": 2, "review_timeout_minutes": 60 }
   ```

## Operating

| Command | What it does |
| --- | --- |
| `node scripts/pr-watch.mjs check <PR url>` | What a new watch of that PR would do now. It is read-only and needs no site or key. If a review is due, it prints the exact `claude` command and prompt. |
| `node scripts/pr-watch.mjs tick --dry-run` | One pass over the real queue. It prints every decision and reports and starts nothing. |
| `node scripts/pr-watch.mjs status` | Whether launchd has the agent loaded, its last exit code, and the last 15 log lines. |
| `node scripts/pr-watch.mjs uninstall` | Removes the LaunchAgent. The queue on the site stays as it is. |

Logs go to `~/.config/personal-hub/logs/pr-watch.log`, which rotates at 5 MB. The page shows when the runner last asked for work. After 15 minutes of silence it shows "runner not running" with the install command.

| Symptom | Look at |
| --- | --- |
| "runner never seen" or "runner not running" | `status`. Check the key's hash in `INGEST_KEYS_JSON`. A 401 in the log means the hash and key do not match. |
| A review never starts | `check <url>`. Common causes: the new commits are a teammate's, the push was a rebase, both slots are busy, or the PR has no AI review yet (use Review now). |
| "ended without posting an AI review" | `claude attach <session>`. The session may have hit a question or a permission prompt. If `auto` blocks the `gh` post, set `permission_mode` in `pr-watch.json`. |
| Every PR looks unreviewed | Check the review header. Detection needs the body to open with "AI review", posted by the `gh` login. |
