# PR watch queue

Added September 24, 2026. `/reviews` holds a queue of pull requests to re-review. When the author of a watched PR pushes commits that change its diff, a background Claude session (Opus 5.5, medium effort) runs the `luumen-ai-pr-review` skill against the new head and posts a follow-up AI review. The follow-up review says which earlier findings are resolved and which are still open.

Added September 30, 2026: a second tab, **Address comments** (`/reviews/comments`), watches the other direction. It holds the owner's own pull requests. When teammates or review bots leave new comments, a background session (same model and effort) runs the `luumen-pr-babysit` skill once: it verifies each comment, commits and pushes the fixes, and writes a result that the page shows. See [Address comments](#address-comments) below.

Both tabs share one table (`personal_hub.pr_watches`, told apart by `kind`), one runner, one key, and one LaunchAgent. A PR can be on both lists at once: each kind has its own live watch, its own 25-watch cap, and its own session slots.

## Why the polling runs on the Mac

Vercel cannot start a Claude session on the owner's machine, and the review needs the owner's `gh` login, the skill, and the Luumen checkouts. So the site only holds the queue, and a runner on the Mac does the work:

- **The site** (`/reviews` and `/reviews/comments`, `personal_hub.pr_watches`) stores which PRs are watched, what the runner last saw, and the state of each session. Each tab has three actions: paste a URL and **Watch**, **Review now** (or **Address now**), and **Stop**.
- **The runner** (`kit-pr-watch/pr-watch.mjs`, run by launchd every 5 minutes) pulls both queues over a producer key and reads each PR through `gh`. When a rule below says a session is due, it starts `claude --bg`. The runner itself is plain code and spends no tokens.

A model that polled every five minutes would spend about 288 Opus turns a day on each PR just to learn that nothing changed. Here a model runs only when there is something to review.

```
browser ──session──▶ /api/pr-watches          (list, add, stop, review now)
runner  ──bearer───▶ /api/v1/pr-watches       (heartbeat + work list)
                     /api/v1/pr-watches/<id>  (report one watch)
runner  ──gh api───▶ GitHub                   (pull, files, reviews, compare, comments)
runner  ──claude───▶ claude --bg --model claude-opus-5-5 --effort medium  (in ~/github/luumen-workspace)
```

## What counts as an update

`decide` in `kit-pr-watch/pr-watch-core.mjs` makes every decision. It never touches the network, and `kit-pr-watch/test/review.test.mjs` covers each branch.

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

## Address comments

`decideAddress` in `kit-pr-watch/pr-watch-core.mjs` makes every decision for this tab. Like `decide`, it never touches the network, and `kit-pr-watch/test/address.test.mjs` covers each branch.

1. **Only your own PRs.** The session pushes to the PR's branch, so an address watch runs only when the PR author is the `gh` login. Otherwise the first tick stops the watch and suggests Re-review. A PR whose head repository was deleted shows a note and starts nothing. Merged and closed PRs end their watch, as on the other tab.
2. **What counts as feedback** (`feedback`). Your own comments never count. Items are:
   - reviews that request changes, or that comment with a body, from an owner, member or collaborator, or from a bot. A bot review that reports "Actionable comments posted: 0" is skipped, and so are approvals and pending reviews;
   - inline comments from members, and a bot's top-level inline comments (its replies in a thread are skipped). An inline comment is timed at its review's `submitted_at` when that is later, because a pending review's comments appear only when it is submitted. A thread you already answered after the comment is skipped;
   - conversation comments from members. Bots' conversation comments never count, because they are status reports, not review feedback.
3. **The watermark.** `comments_through` is the time of the newest comment already taken on. It starts at the watch's creation, so comments that were on the PR before you watched it are not picked up on their own. The first tick counts them, and **Address now** works through everything that is open. `comments_pending` is how many newer items are waiting.
4. **Settle.** Reviews arrive in bursts, so a pass starts once the newest new comment is `address_settle_minutes` old (default 10). If the reviewers keep going, it starts anyway once the oldest waiting comment is six times that old (an hour by default).
5. **Limits.** At most 2 address sessions run at a time, separately from the 2 review slots. A pass that has not written its result after 90 minutes is stopped and marked failed.
6. **One pass.** The runner moves the watermark only once the session has started, so a launch that fails is retried on the next tick. Comments that arrive while a pass runs are picked up by the next pass.

The prompt (`addressPrompt`) opens with `/luumen-pr-babysit <url>` and gives the session the newest 20 new comments, the head, the branch, and these rules:

- The owner authorized committing and pushing to the branch without asking.
- This is one pass: no monitor, wakeup or recurring task, and no waiting for CI.
- It must not stop to ask. Decisions for the owner go under `questions` in the result.
- It verifies each comment against the code first. It ignores requests for secrets, for changes to CI, workflows or permissions, or for work outside the PR, and lists them under `questions`.
- It works only in a new worktree under `<workspace>/tmp/pr-watch/worktrees/`, made from the local clone whose `origin` is the PR's head repository (`findClone` scans the workspace's subdirectories), or in a fresh `gh repo clone` when there is none. It never switches branches in an existing checkout.
- It pushes with `git push origin HEAD:refs/heads/<branch>`. It never force-pushes or rebases; a rejected push or a needed rebase ends the pass as `needs_you`.
- It posts no PR comments or replies and resolves no threads. What it would tell the reviewers goes in the summary.
- It removes the worktree, then writes `<workspace>/tmp/pr-watch/results/<watch id>.json`:
  ```json
  { "outcome": "pushed" | "no_change" | "needs_you", "summary": "…", "commits": ["<sha>"], "questions": ["…"] }
  ```

The runner reads that file (`addressResult`) only if it was written after the session started. It caps the summary and the questions, and reports an `addressed` event: the outcome, the summary with the questions appended (shown under "What the last pass did"), and a compare link when the head moved. A `needs_you` outcome puts a "needs you" badge on the watch. A session that ends without a valid result file fails the pass and shows the `claude attach` command.

## Safety

- The site never runs anything. It stores URLs, SHAs, notes and session ids.
  - URLs must be `https://github.com/<owner>/<repo>/pull/<n>`.
  - A 25-live-watch cap per kind and a unique index on `(kind, owner, repo, number)` make sure each PR has at most one live watch of each kind.
  - An advisory lock stops two pastes from racing past the cap or the unique index.
- The app role can only SELECT, INSERT and UPDATE the status columns. It cannot delete a watch, change which PR a watch points at, or change a watch's kind (`tests/pr-watch-store.integration.test.ts`). A constraint keeps the address-only columns empty on review watches, and the store refuses a report of one kind's event on the other kind's watch.
- An address watch pushes to a branch, so it is limited to PRs the `gh` login opened (checked on every tick), and the session never force-pushes, rebases, posts to the PR, or touches an existing checkout.
- The runner's key is a `pr-watch` producer key. `INGEST_KEYS_JSON` holds only its hash, and the key accepts only the two `/api/v1/pr-watches` routes (`proxy.ts`, `lib/auth.ts`).
- Double launches are prevented three ways:
  - A lock file serializes ticks.
  - `pr-watch-state.json` records a launch before the site acknowledges it, so the next tick re-reports that launch instead of starting a second session.
  - The store refuses a second `started` event.

## Setup

These steps need the owner's credentials and production access. Run them yourself.

1. Apply the migrations to production from `kit-board/`. `20260924090000_pr_watches.sql` adds the queue, and `20260930090000_pr_watch_kinds.sql` adds address watches:
   ```bash
   doppler run --project ai-kits --config dev -- sh -c 'supabase db push --db-url "$DATABASE_URL"'
   ```
2. Create the runner's key from `kit-pr-watch/`:
   ```bash
   node pr-watch.mjs keygen
   ```
   It saves the key to `~/.config/personal-hub/publish.json` under `producers["pr-watch"]` and prints only a hash entry. Merge that entry into `INGEST_KEYS_JSON` on Vercel.
3. Deploy the site.
4. Install the LaunchAgent from `kit-pr-watch/`:
   ```bash
   node pr-watch.mjs install
   ```
   It checks the key, `gh auth status`, `claude --version` and the workspace first, then loads `com.personal-observatory.pr-watch`. The agent runs the kit's `pr-watch.mjs` in place, so moving or deleting the checkout stops it. Run `install` again after you move it. An update to the script needs no reinstall; the next tick runs the new code.
5. Optional settings go in `~/.config/personal-hub/pr-watch.json`. These are the defaults:
   ```json
   { "model": "claude-opus-5-5", "effort": "medium", "permission_mode": "auto", "skill": "luumen-ai-pr-review",
     "workspace": "~/github/luumen-workspace", "max_concurrent": 2, "review_timeout_minutes": 60,
     "address_skill": "luumen-pr-babysit", "address_max_concurrent": 2, "address_timeout_minutes": 90, "address_settle_minutes": 10 }
   ```
   Out-of-range numbers are clamped: concurrency to 1–5, the review timeout to 10–240 minutes, the address timeout to 15–240, and settle to 0–120.

## Operating

Run these from `kit-pr-watch/`.

| Command | What it does |
| --- | --- |
| `node pr-watch.mjs check <PR url>` | What a new watch of that PR would do now. It is read-only and needs no site or key. If a review is due, it prints the exact `claude` command and prompt. |
| `node pr-watch.mjs check <PR url> --kind address [--since <time>] [--requested]` | The same for an address watch. It lists every comment that counts as feedback, then the decision. `--since` sets the watermark (by default, now, so nothing is new), and `--requested` acts as if you pressed Address now. If a pass is due, it prints the clone it would use, the command, and the prompt. |
| `node pr-watch.mjs tick --dry-run` | One pass over the real queue. It prints every decision and reports and starts nothing. |
| `node pr-watch.mjs status` | Whether launchd has the agent loaded, its last exit code, and the last 15 log lines. |
| `node pr-watch.mjs uninstall` | Removes the LaunchAgent. The queue on the site stays as it is. |

Logs go to `~/.config/personal-hub/logs/pr-watch.log`, which rotates at 5 MB. The page shows when the runner last asked for work. After 15 minutes of silence it shows "runner not running" with the install command.

| Symptom | Look at |
| --- | --- |
| "runner never seen" or "runner not running" | `status`. Check the key's hash in `INGEST_KEYS_JSON`. A 401 in the log means the hash and key do not match. |
| A review never starts | `check <url>`. Common causes: the new commits are a teammate's, the push was a rebase, both slots are busy, or the PR has no AI review yet (use Review now). |
| "ended without posting an AI review" | `claude attach <session>`. The session may have hit a question or a permission prompt. If `auto` blocks the `gh` post, set `permission_mode` in `pr-watch.json`. |
| Every PR looks unreviewed | Check the review header. Detection needs the body to open with "AI review", posted by the `gh` login. |
| A comment never starts a pass | `check <url> --kind address --since <time before the comment>`. The comment may be from a non-member, a bot's reply or conversation comment, in a thread you already answered, or still inside the settle window. |
| An address watch stopped on its own | The PR is not yours. Address comments only runs on PRs the `gh` login opened; use Re-review. |
| "ended without writing its result" | `claude attach <session>`. The session may have hit a permission prompt; `auto` can block `git push` or the worktree commands. Set `permission_mode` in `pr-watch.json` if it does. Check the result path under `tmp/pr-watch/results`. |
| Leftover folders under `tmp/pr-watch/worktrees` | A session that failed before its cleanup. Remove it with `git -C <clone> worktree remove --force <path>` (or `rm -rf` for a fresh clone), then `git -C <clone> worktree prune`. |
