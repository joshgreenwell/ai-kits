#!/usr/bin/env node
// PR watch runner (docs/pr-watch.md). launchd runs `tick` every five minutes on this Mac: it reads the
// queue from the site, looks at each pull request through gh, and when the PR author has pushed a
// change to the diff it starts a background Claude session that runs the AI review skill. Polling is
// plain code; a model runs only for a review.
//
//   node scripts/pr-watch.mjs tick [--dry-run]    one pass over the queue (what launchd runs)
//   node scripts/pr-watch.mjs check <PR url>      what a new watch would do, read-only, no site needed
//   node scripts/pr-watch.mjs keygen [--rotate]   create the runner's producer key; prints only its hash
//   node scripts/pr-watch.mjs install | uninstall | status
//
// The key lives in ~/.config/personal-hub/publish.json under producers["pr-watch"] and never goes into
// arguments or logs. Optional settings live beside it in pr-watch.json.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { backgroundedSession, decide, defaults, reviewPrompt, short } from './pr-watch-core.mjs';

const run = promisify(execFile);
const VERSION = '1.0.0';
const LABEL = 'com.personal-observatory.pr-watch';
const PRODUCER = 'pr-watch';

const [command = 'tick', ...rest] = process.argv.slice(2);
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !/^--(config|head|reviewed)$/.test(rest[i - 1] ?? ''));
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
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(merged.model) || !/^[a-z]{1,16}$/.test(merged.effort) || !/^[A-Za-z]{1,32}$/.test(merged.permission_mode) || !/^[A-Za-z0-9:_-]{1,80}$/.test(merged.skill)) {
    throw new Error(`Invalid model, effort, permission_mode, or skill in ${settingsPath}`);
  }
  merged.max_concurrent = Math.max(1, Math.min(5, Number(merged.max_concurrent) || defaults.max_concurrent));
  merged.review_timeout_minutes = Math.max(10, Math.min(240, Number(merged.review_timeout_minutes) || defaults.review_timeout_minutes));
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

const stopSession = session => run('claude', ['stop', session], { timeout: 30_000 }).catch(error => log(`Could not stop session ${session}: ${firstLine(error.stderr || error.message)}`));

// ---- The site ------------------------------------------------------------------------------------

async function siteClient() {
  const config = await readJsonFile(publishPath);
  const url = new URL(config.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('HTTPS is required');
  const credential = config.producers?.[PRODUCER];
  if (!credential?.key || !credential.kinds?.includes(PRODUCER)) throw new Error(`No "${PRODUCER}" producer key in ${publishPath}; run: node scripts/pr-watch.mjs keygen`);
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
  const { watches } = await site(`/api/v1/pr-watches?machine=${encodeURIComponent(hostname().slice(0, 80))}&version=${VERSION}`);
  if (!watches.length) { log('The queue is empty.'); return; }
  const viewer = (await gh(['user'])).login;
  const agents = once(claudeAgents);
  const state = await readJsonFile(statePath, { launched: {} });
  // A launch the site never heard about, for a watch that has since left the queue, has nothing left to report.
  const listed = new Set(watches.map(watch => watch.id));
  const stale = Object.keys(state.launched).filter(id => !listed.has(id));
  if (stale.length && !dryRun) { for (const id of stale) delete state.launched[id]; await writePrivate(statePath, state); }
  let slots = config.max_concurrent - watches.filter(watch => watch.review_state === 'running').length;

  for (const watch of watches) {
    const label = `${watch.owner}/${watch.repo}#${watch.number}`;
    try {
      // A review started on an earlier tick whose report never reached the site: report it, never start a second one.
      const pending = state.launched[watch.id];
      if (pending && watch.review_state === 'running') { delete state.launched[watch.id]; await writePrivate(statePath, state); }
      else if (pending) {
        if (!dryRun) {
          await site(`/api/v1/pr-watches/${watch.id}`, { checked_at: new Date().toISOString(), head_sha: pending.target_sha, head_fingerprint: pending.fingerprint,
            review: { event: 'started', session: pending.session, target_sha: pending.target_sha, started_at: pending.started_at }, note: pending.note, error: null })
            .catch(error => { if (error.status !== 409) throw error; });
          delete state.launched[watch.id]; await writePrivate(statePath, state);
        }
        log(label, `re-reported review session ${pending.session}`);
        slots--;
        continue;
      }
      const source = github(watch);
      const pull = await source.pull();
      const decision = await decide({ watch, pull, files: source.files, reviews: source.reviews, newCommits: source.newCommits, agents, viewer, slot: slots > 0, now: new Date(), config });
      let report = decision.report;
      if (dryRun) { console.log(JSON.stringify({ watch: label, report, action: decision.action })); continue; }
      if (decision.action?.type === 'stop') await stopSession(decision.action.session);
      if (decision.action?.type === 'review') {
        try {
          const session = await startReview(config, watch, pull, decision.action);
          const started_at = new Date().toISOString();
          const note = `Review started in session ${session}: ${decision.action.reason}`;
          slots--;
          state.launched[watch.id] = { session, target_sha: decision.action.target_sha, fingerprint: report.head_fingerprint, started_at, note };
          await writePrivate(statePath, state);
          report = { ...report, review: { event: 'started', session, target_sha: decision.action.target_sha, started_at }, note };
        } catch (error) {
          // Leave the head where it was, so the next tick tries again.
          const { head_sha, head_fingerprint, baseline_source, reviewed_sha, ...kept } = report;
          report = { ...kept, error: `Could not start the review: ${firstLine(error.stderr || error.message)}` };
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

/** What a fresh watch of this PR would do right now, without the site and without starting anything. */
async function check(input) {
  const match = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]*)/.exec(input ?? '');
  if (!match) throw new Error('Usage: node scripts/pr-watch.mjs check https://github.com/owner/repo/pull/123');
  const [, owner, repo, number] = match;
  const watch = { id: 'check', owner, repo, number: Number(number), url: `https://github.com/${owner}/${repo}/pull/${number}`, status: 'watching', review_state: 'idle',
    head_sha: option('head') ?? null, head_fingerprint: null, reviewed_sha: option('reviewed') ?? null, review_requested_at: null, last_note: null };
  const config = await settings();
  const source = github(watch);
  const pull = await source.pull();
  const viewer = (await gh(['user'])).login;
  const decision = await decide({ watch, pull, files: source.files, reviews: source.reviews, newCommits: source.newCommits, agents: claudeAgents, viewer, slot: true, now: new Date(), config });
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
