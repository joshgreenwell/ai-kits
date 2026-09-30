#!/usr/bin/env node
// PR watch runner (kit-board/docs/pr-watch.md). launchd runs `tick` every five minutes on this Mac: it reads the
// queue from the site and looks at each pull request through gh. On a review watch, when the PR author
// has pushed a change to the diff, it starts a background Claude session that runs the AI review skill.
// On an address watch, when reviewers leave new comments on the owner's own PR, it starts one that works
// through them and pushes the fixes. Polling is plain code; a model runs only when there is work.
//
//   node pr-watch.mjs tick [--dry-run]    one pass over the queue (what launchd runs)
//   node pr-watch.mjs check <PR url> [--kind address] [--since <time>] [--requested]
//                                         what a new watch would do, read-only, no site needed
//   node pr-watch.mjs keygen [--rotate]   create the runner's producer key; prints only its hash
//   node pr-watch.mjs install | uninstall | status
//
// The key lives in ~/.config/personal-hub/publish.json under producers["pr-watch"] and never goes into
// arguments or logs. Optional settings live beside it in pr-watch.json.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { addressPrompt, addressResult, backgroundedSession, decide, decideAddress, defaults, feedback, remoteMatches, reviewPrompt, short } from './pr-watch-core.mjs';

const run = promisify(execFile);
const VERSION = '1.1.0';
const LABEL = 'com.personal-observatory.pr-watch';
const PRODUCER = 'pr-watch';

const [command = 'tick', ...rest] = process.argv.slice(2);
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !/^--(config|head|reviewed|kind|since)$/.test(rest[i - 1] ?? ''));
const flag = name => rest.includes(`--${name}`);
const option = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

const publishPath = resolve(option('config') ?? process.env.PERSONAL_HUB_CONFIG ?? `${homedir()}/.config/personal-hub/publish.json`);
const dir = dirname(publishPath);
const settingsPath = resolve(dir, 'pr-watch.json');
const statePath = resolve(dir, 'pr-watch-state.json');
const lockPath = resolve(dir, 'pr-watch.lock');
const logPath = resolve(dir, 'logs', 'pr-watch.log');
const plistPath = `${homedir()}/Library/LaunchAgents/${LABEL}.plist`;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const firstLine = value => String(value ?? '').split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 300) ?? 'unknown error';
const readJsonFile = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; } };
const writePrivate = async (path, value) => { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path); };
const once = fn => { let value; return () => value ??= fn(); };

async function settings() {
  const own = await readJsonFile(settingsPath, {});
  const merged = { ...defaults, workspace: `${homedir()}/github/luumen-workspace`, ...own };
  merged.workspace = merged.workspace.replace(/^~(?=\/|$)/, homedir());
  const skill = /^[A-Za-z0-9:_-]{1,80}$/;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(merged.model) || !/^[a-z]{1,16}$/.test(merged.effort) || !/^[A-Za-z]{1,32}$/.test(merged.permission_mode) || !skill.test(merged.skill) || !skill.test(merged.address_skill)) {
    throw new Error(`Invalid model, effort, permission_mode, skill, or address_skill in ${settingsPath}`);
  }
  const clamp = (key, min, max) => { merged[key] = Math.max(min, Math.min(max, Number.isFinite(Number(merged[key])) ? Number(merged[key]) : defaults[key])); };
  clamp('max_concurrent', 1, 5);
  clamp('review_timeout_minutes', 10, 240);
  clamp('address_max_concurrent', 1, 5);
  clamp('address_timeout_minutes', 15, 240);
  clamp('address_settle_minutes', 0, 120);
  return merged;
}

// ---- GitHub, through the owner's gh login ------------------------------------------------------

async function gh(args, { missing = false } = {}) {
  try {
    const { stdout } = await run('gh', ['api', ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    return JSON.parse(stdout);
  } catch (error) {
    // A compare against a force-pushed-away head, or a PR the login cannot see.
    if (missing && /HTTP (404|422)/.test(error.stderr ?? '')) return null;
    throw new Error(`GitHub read failed (${args.at(-1).split('?')[0]}): ${firstLine(error.stderr || error.message)}`);
  }
}
const pages = async path => (await gh(['--paginate', '--slurp', path])).flat();

function github(watch) {
  const base = `repos/${watch.owner}/${watch.repo}`;
  return {
    pull: () => gh([`${base}/pulls/${watch.number}`]),
    files: once(() => pages(`${base}/pulls/${watch.number}/files?per_page=100`)),
    reviews: once(() => pages(`${base}/pulls/${watch.number}/reviews?per_page=100`)),
    reviewComments: once(() => pages(`${base}/pulls/${watch.number}/comments?per_page=100`)),
    issueComments: once(() => pages(`${base}/issues/${watch.number}/comments?per_page=100`)),
    newCommits: async (from, to) => (await gh([`${base}/compare/${from}...${to}?per_page=100`], { missing: true }))?.commits ?? null,
  };
}

// ---- Claude background sessions ----------------------------------------------------------------

async function claudeAgents() {
  const { stdout } = await run('claude', ['agents', '--json', '--all'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : parsed.agents ?? [];
}

async function startReview(config, watch, pull, action) {
  const prompt = reviewPrompt({ watch, pull, reason: action.reason, since: action.since, skill: config.skill });
  const name = `PR review · ${watch.owner}/${watch.repo}#${watch.number} · ${short(action.target_sha)}`;
  const { stdout, stderr } = await run('claude', ['--bg', '--model', config.model, '--effort', config.effort, '--permission-mode', config.permission_mode, '-n', name, prompt],
    { cwd: config.workspace, timeout: 120_000 });
  const session = backgroundedSession(`${stdout}\n${stderr}`);
  if (!session) throw new Error(`claude --bg did not report a session: ${firstLine(stderr || stdout)}`);
  return session;
}

// An address session works in a worktree under the workspace's git-ignored tmp/ and leaves its result
// file there; the runner reads that file to learn how the pass went.
const addressPaths = (config, watch, target) => {
  const root = resolve(config.workspace, 'tmp', 'pr-watch');
  return {
    results: resolve(root, 'results'),
    result: resolve(root, 'results', `${watch.id}.json`),
    worktree: resolve(root, 'worktrees', `${watch.repo}-${watch.number}-${short(target)}-${Date.now().toString(36)}`),
  };
};

/** The workspace checkout whose origin is this repository, so the session can add a worktree to it; null when none is. */
async function findClone(config, fullName) {
  const entries = await readdir(config.workspace, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter(item => item.isDirectory() && !item.name.startsWith('.') && item.name !== 'tmp')) {
    const path = resolve(config.workspace, entry.name);
    const remote = await run('git', ['-C', path, 'remote', 'get-url', 'origin'], { timeout: 10_000 }).then(out => out.stdout, () => '');
    if (remoteMatches(remote, fullName)) return path;
  }
  return null;
}

async function startAddress(config, watch, pull, action) {
  const paths = addressPaths(config, watch, action.target_sha);
  // A result left by an earlier pass must not read as this pass's result.
  await rm(paths.result, { force: true });
  await mkdir(paths.results, { recursive: true });
  await mkdir(dirname(paths.worktree), { recursive: true });
  const clone = await findClone(config, pull.head.repo.full_name);
  const prompt = addressPrompt({ watch, pull, reason: action.reason, comments: action.comments, skill: config.address_skill, resultPath: paths.result, worktree: paths.worktree, clone });
  const name = `PR comments · ${watch.owner}/${watch.repo}#${watch.number} · ${short(action.target_sha)}`;
  const { stdout, stderr } = await run('claude', ['--bg', '--model', config.model, '--effort', config.effort, '--permission-mode', config.permission_mode, '-n', name, prompt],
    { cwd: config.workspace, timeout: 120_000 });
  const session = backgroundedSession(`${stdout}\n${stderr}`);
  if (!session) throw new Error(`claude --bg did not report a session: ${firstLine(stderr || stdout)}`);
  return session;
}

/** The running address session's result, once it has written one for this pass. */
async function readResult(config, watch) {
  const { result } = addressPaths(config, watch, watch.review_target_sha);
  const info = await stat(result).catch(() => null);
  if (!info || info.mtimeMs < Date.parse(watch.review_started_at) - 60_000) return null;
  // A half-written file reads as no result yet; the next tick reads it again.
  return addressResult(await readJsonFile(result).catch(() => null));
}

const stopSession = session => run('claude', ['stop', session], { timeout: 30_000 }).catch(error => log(`Could not stop session ${session}: ${firstLine(error.stderr || error.message)}`));

// ---- The site ------------------------------------------------------------------------------------

async function siteClient() {
  const config = await readJsonFile(publishPath);
  const url = new URL(config.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('HTTPS is required');
  const credential = config.producers?.[PRODUCER];
  if (!credential?.key || !credential.kinds?.includes(PRODUCER)) throw new Error(`No "${PRODUCER}" producer key in ${publishPath}; run: node pr-watch.mjs keygen`);
  return async (path, body) => {
    const response = await fetch(new URL(path, url), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${credential.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(`The site answered ${response.status}: ${payload.error ?? 'no detail'}`); error.status = response.status; throw error; }
    return payload;
  };
}

// ---- One tick --------------------------------------------------------------------------------------

async function withLock(fn) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.close();
      try { return await fn(); } finally { await rm(lockPath, { force: true }); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''));
      let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
      if (alive) { log(`Another tick (pid ${pid}) is still running; skipping this one.`); return; }
      await rm(lockPath, { force: true });
    }
  }
}

async function rotateLog() {
  const size = await stat(logPath).then(info => info.size, () => 0);
  if (size > 5 * 1024 * 1024) await rename(logPath, `${logPath}.1`).catch(() => {});
}

async function tick() {
  const dryRun = flag('dry-run');
  if (!dryRun) await rotateLog();
  const config = await settings();
  const site = await siteClient();
  const { watches: listed } = await site(`/api/v1/pr-watches?machine=${encodeURIComponent(hostname().slice(0, 80))}&version=${VERSION}`);
  // A site from before address watches sends no kind; every watch it has is a review watch.
  const watches = listed.map(watch => ({ kind: 'review', ...watch }));
  if (!watches.length) { log('The queue is empty.'); return; }
  const viewer = (await gh(['user'])).login;
  const agents = once(claudeAgents);
  const state = await readJsonFile(statePath, { launched: {} });
  // A launch the site never heard about, for a watch that has since left the queue, has nothing left to report.
  const ids = new Set(watches.map(watch => watch.id));
  const stale = Object.keys(state.launched).filter(id => !ids.has(id));
  if (stale.length && !dryRun) { for (const id of stale) delete state.launched[id]; await writePrivate(statePath, state); }
  // Each kind has its own cap, so a burst of comments cannot hold up re-reviews or the other way round.
  const running = kind => watches.filter(watch => watch.kind === kind && watch.review_state === 'running').length;
  const slots = { review: config.max_concurrent - running('review'), address: config.address_max_concurrent - running('address') };

  for (const watch of watches) {
    const label = `${watch.owner}/${watch.repo}#${watch.number}${watch.kind === 'address' ? ' (comments)' : ''}`;
    try {
      // A session started on an earlier tick whose report never reached the site: report it, never start a second one.
      const pending = state.launched[watch.id];
      if (pending && watch.review_state === 'running') { delete state.launched[watch.id]; await writePrivate(statePath, state); }
      else if (pending) {
        if (!dryRun) {
          await site(`/api/v1/pr-watches/${watch.id}`, { checked_at: new Date().toISOString(), head_sha: pending.target_sha, head_fingerprint: pending.fingerprint,
            ...(pending.comments_through ? { comments_through: pending.comments_through, comments_pending: 0 } : {}),
            review: { event: 'started', session: pending.session, target_sha: pending.target_sha, started_at: pending.started_at }, note: pending.note, error: null })
            .catch(error => { if (error.status !== 409) throw error; });
          delete state.launched[watch.id]; await writePrivate(statePath, state);
        }
        log(label, `re-reported session ${pending.session}`);
        slots[watch.kind]--;
        continue;
      }
      const source = github(watch);
      const pull = await source.pull();
      const now = new Date();
      const decision = watch.kind === 'address'
        ? await decideAddress({ watch, pull, reviews: source.reviews, reviewComments: source.reviewComments, issueComments: source.issueComments, agents,
          result: () => readResult(config, watch), viewer, slot: slots.address > 0, now, config })
        : await decide({ watch, pull, files: source.files, reviews: source.reviews, newCommits: source.newCommits, agents, viewer, slot: slots.review > 0, now, config });
      let report = decision.report;
      if (dryRun) { console.log(JSON.stringify({ watch: label, report, action: decision.action })); continue; }
      if (decision.action?.type === 'stop') await stopSession(decision.action.session);
      if (decision.action?.type === 'review') {
        try {
          const session = await startReview(config, watch, pull, decision.action);
          const started_at = new Date().toISOString();
          const note = `Review started in session ${session}: ${decision.action.reason}`;
          slots.review--;
          state.launched[watch.id] = { session, target_sha: decision.action.target_sha, fingerprint: report.head_fingerprint, started_at, note };
          await writePrivate(statePath, state);
          report = { ...report, review: { event: 'started', session, target_sha: decision.action.target_sha, started_at }, note };
        } catch (error) {
          // Leave the head where it was, so the next tick tries again.
          const { head_sha, head_fingerprint, baseline_source, reviewed_sha, ...kept } = report;
          report = { ...kept, error: `Could not start the review: ${firstLine(error.stderr || error.message)}` };
        }
      }
      if (decision.action?.type === 'address') {
        try {
          const session = await startAddress(config, watch, pull, decision.action);
          const started_at = new Date().toISOString();
          const note = `Addressing comments in session ${session}: ${decision.action.reason}`;
          const { target_sha, through } = decision.action;
          slots.address--;
          state.launched[watch.id] = { session, target_sha, comments_through: through, started_at, note };
          await writePrivate(statePath, state);
          // The comments this pass took on stop counting as new only now that it has started.
          report = { ...report, comments_through: through, comments_pending: 0, review: { event: 'started', session, target_sha, started_at }, note };
        } catch (error) {
          // The watermark has not moved, so the next tick tries again.
          report = { ...report, error: `Could not start the session: ${firstLine(error.stderr || error.message)}` };
        }
      }
      if (report) {
        await site(`/api/v1/pr-watches/${watch.id}`, report);
        if (state.launched[watch.id]) { delete state.launched[watch.id]; await writePrivate(statePath, state); }
        log(label, report.error ?? report.note ?? 'checked');
      }
    } catch (error) {
      log(label, `error: ${firstLine(error.message)}`);
      if (!dryRun && error.status === undefined) {
        await site(`/api/v1/pr-watches/${watch.id}`, { checked_at: new Date().toISOString(), error: firstLine(error.message) }).catch(() => {});
      }
    }
  }
}

/**
 * What a fresh watch of this PR would do right now, without the site and without starting anything.
 * --kind address looks at it as an address watch; --since treats comments after that time as new;
 * --requested acts as if Review now or Address now had been pressed.
 */
async function check(input) {
  const match = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]*)/.exec(input ?? '');
  if (!match) throw new Error('Usage: node pr-watch.mjs check https://github.com/owner/repo/pull/123 [--kind address] [--since <time>] [--requested]');
  const [, owner, repo, number] = match;
  const kind = option('kind') ?? 'review';
  if (!['review', 'address'].includes(kind)) throw new Error('--kind is review or address');
  const since = option('since');
  if (since !== undefined && Number.isNaN(Date.parse(since))) throw new Error('--since needs a time, such as 2026-09-30T12:00:00Z');
  const now = new Date();
  const watch = { id: 'check', kind, owner, repo, number: Number(number), url: `https://github.com/${owner}/${repo}/pull/${number}`, status: 'watching', review_state: 'idle',
    head_sha: option('head') ?? null, head_fingerprint: null, reviewed_sha: option('reviewed') ?? null, review_requested_at: flag('requested') ? now.toISOString() : null, last_note: null,
    comments_through: since ? new Date(since).toISOString() : null, created_at: now.toISOString() };
  const config = await settings();
  const source = github(watch);
  const pull = await source.pull();
  const viewer = (await gh(['user'])).login;
  if (kind === 'address') {
    const decision = await decideAddress({ watch, pull, reviews: source.reviews, reviewComments: source.reviewComments, issueComments: source.issueComments,
      agents: claudeAgents, result: async () => null, viewer, slot: true, now, config });
    const items = feedback({ reviews: await source.reviews(), reviewComments: await source.reviewComments(), issueComments: await source.issueComments(), viewer });
    console.log(JSON.stringify({ viewer, head: pull.head.sha, author: pull.user?.login, feedback: items, ...decision }, null, 2));
    if (decision.action?.type === 'address') {
      const paths = addressPaths(config, watch, decision.action.target_sha);
      const clone = await findClone(config, pull.head.repo.full_name);
      console.log('\nWould run, in', config.workspace + ':');
      console.log(`claude --bg --model ${config.model} --effort ${config.effort} --permission-mode ${config.permission_mode} -n "PR comments · ${owner}/${repo}#${number} · ${short(pull.head.sha)}" <prompt>\n`);
      console.log(addressPrompt({ watch, pull, reason: decision.action.reason, comments: decision.action.comments, skill: config.address_skill, resultPath: paths.result, worktree: paths.worktree, clone }));
    }
    return;
  }
  const decision = await decide({ watch, pull, files: source.files, reviews: source.reviews, newCommits: source.newCommits, agents: claudeAgents, viewer, slot: true, now, config });
  console.log(JSON.stringify({ viewer, head: pull.head.sha, author: pull.user?.login, ...decision }, null, 2));
  if (decision.action?.type === 'review') {
    console.log('\nWould run, in', config.workspace + ':');
    console.log(`claude --bg --model ${config.model} --effort ${config.effort} --permission-mode ${config.permission_mode} -n "PR review · ${owner}/${repo}#${number} · ${short(pull.head.sha)}" <prompt>\n`);
    console.log(reviewPrompt({ watch, pull, reason: decision.action.reason, since: decision.action.since, skill: config.skill }));
  }
}

// ---- Setup ---------------------------------------------------------------------------------------

async function keygen() {
  const config = await readJsonFile(publishPath);
  if (config.producers?.[PRODUCER]?.key && !flag('rotate')) throw new Error(`A "${PRODUCER}" key already exists in ${publishPath}; pass --rotate to replace it`);
  const key = randomBytes(32).toString('base64url');
  config.producers = { ...config.producers, [PRODUCER]: { key, kinds: [PRODUCER] } };
  await writePrivate(publishPath, config);
  await chmod(publishPath, 0o600);
  const hash = createHash('sha256').update(key).digest('hex');
  console.log(`Saved the key to ${publishPath}. Add this entry to INGEST_KEYS_JSON on Vercel (the hash only; the key stays on this Mac):`);
  console.log(JSON.stringify({ [PRODUCER]: { hash, kinds: [PRODUCER] } }));
}

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const launchctl = (...args) => run('launchctl', args).catch(error => ({ stdout: '', stderr: error.stderr ?? '', failed: true }));

async function install() {
  await siteClient();
  const config = await settings();
  await stat(config.workspace).catch(() => { throw new Error(`The review workspace ${config.workspace} does not exist; set "workspace" in ${settingsPath}`); });
  await run('gh', ['auth', 'status']).catch(() => { throw new Error('gh is not signed in; run: gh auth login'); });
  await run('claude', ['--version']).catch(() => { throw new Error('The claude command is not on PATH'); });
  const script = fileURLToPath(import.meta.url);
  const path = [dirname(process.execPath), `${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(plistPath), { recursive: true });
  const args = [process.execPath, script, 'tick', '--config', publishPath].map(arg => `    <string>${xml(arg)}</string>`).join('\n');
  // AbandonProcessGroup: the review session outlives the tick that started it.
  await writeFile(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>AbandonProcessGroup</key><true/>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  await launchctl('bootout', `${domain}/${LABEL}`);
  const loaded = await launchctl('bootstrap', domain, plistPath);
  if (loaded.failed) throw new Error(`launchctl bootstrap failed: ${firstLine(loaded.stderr)}`);
  console.log(JSON.stringify({ ok: true, label: LABEL, every_minutes: 5, log: logPath, workspace: config.workspace, model: config.model, effort: config.effort }));
}

async function uninstall() {
  await launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
  await rm(plistPath, { force: true });
  console.log(JSON.stringify({ ok: true, removed: LABEL }));
}

async function status() {
  const printed = await launchctl('print', `gui/${process.getuid()}/${LABEL}`);
  const field = name => new RegExp(`\\n\\s*${name} = ([^\\n]+)`).exec(printed.stdout)?.[1] ?? null;
  const tail = (await readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').slice(-15).join('\n');
  console.log(JSON.stringify({ installed: !printed.failed, state: field('state'), last_exit: field('last exit code'), log: logPath }, null, 2));
  if (tail) console.log(`\n${tail}`);
}

const commands = { tick: () => withLock(tick), check: () => check(positional[0]), keygen, install, uninstall, status };
if (!commands[command]) { console.error(`Unknown command "${command}". Commands: ${Object.keys(commands).join(', ')}`); process.exit(2); }
try { await commands[command](); }
catch (error) { log(`pr-watch ${command} failed: ${firstLine(error.message)}`); process.exitCode = 1; }
