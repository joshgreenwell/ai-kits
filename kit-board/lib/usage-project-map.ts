/**
 * Project resolution at read time (spec section 6.1), in one place for the Tokens read
 * (lib/usage-query.ts) and Settings > Projects (lib/usage-store.ts `listProjectStats`).
 *
 * canonical_requests carries each request's project EVIDENCE only (the install that reported it, its
 * session, and the folder key when the basis is a working directory), never a resolved project, so an
 * app's later catalog or membership relabels history without a write. Resolution runs over the DISTINCT
 * evidence tuples of the rows in scope (about 800 for a month) rather than per request row, and the
 * requests then join the resolved map on plain equality, which keeps the label and membership tables
 * out of any per-row loop over canonical_requests.
 *
 * Precedence: an explicit No project (basis `none`) first; then the session's membership, which is the
 * app's own assignment; then the folder's membership. No state filter on app projects: a removed project
 * keeps its history and is labelled "(removed)" once no active app project with its id remains.
 *
 * | condition                                                     | state          |
 * | basis none                                                    | no_project     |
 * | membership naming a project the catalog has                   | project        |
 * | membership `projectless` (an app chat with no project)        | no_project     |
 * | membership outside_roots / no_folder, or an unknown project   | unassigned     |
 * | no membership, install never reported project data            | not_reported   |
 * | no membership, install has reported                           | unknown        |
 */
export const PROJECTLESS_LABEL = 'Chats / no project';
export const NOT_REPORTED_SUFFIX = ': companion update needed';

/**
 * `keys` is a SELECT exposing project_install_id, session_hash, effective_project_basis and
 * effective_project_key (plus anything else, which is carried through). The result is a CTE chain ending
 * in `project_map`, one row per input row, with the resolved `project_state`, `project_id`,
 * `project_label`, the deciding `resolution` and `project_reason` (the Settings breakdown's bucket).
 */
export const projectMapCtes = (keys: string) => `pm_keys AS (${keys}),
    project_display AS (
      SELECT DISTINCT ON (project_id) project_id, name, state
      FROM personal_hub.usage_app_projects
      ORDER BY project_id, (state = 'active') DESC, observed_at DESC
    ), pm_joined AS (
      SELECT k.*, x.resolution, ap.project_id AS app_project_id, ap.app, pd.name AS display_name, pd.state AS display_state,
        (rep.install_id IS NOT NULL) AS reported, ci.machine_label
      FROM pm_keys k
      LEFT JOIN personal_hub.usage_project_memberships sm
        ON sm.install_id = k.project_install_id AND sm.member_kind = 'session' AND sm.member_key = k.session_hash
      LEFT JOIN personal_hub.usage_project_memberships wm
        ON k.effective_project_basis = 'working_directory' AND wm.install_id = k.project_install_id
        AND wm.member_kind = 'working_directory' AND wm.member_key = k.effective_project_key
      CROSS JOIN LATERAL (SELECT
          CASE WHEN sm.install_id IS NOT NULL THEN sm.resolution ELSE wm.resolution END AS resolution,
          CASE WHEN sm.install_id IS NOT NULL THEN sm.project_key ELSE wm.project_key END AS project_key) x
      LEFT JOIN personal_hub.usage_app_projects ap ON ap.install_id = k.project_install_id AND ap.project_key = x.project_key
      LEFT JOIN personal_hub.usage_project_reports rep ON rep.install_id = k.project_install_id
      LEFT JOIN personal_hub.companion_installs ci ON ci.id = k.project_install_id
      LEFT JOIN project_display pd ON pd.project_id = ap.project_id
    ), project_map AS (
      SELECT j.*, s.project_state, s.project_reason,
        CASE WHEN s.project_state = 'project' THEN j.app_project_id END AS project_id,
        CASE
          WHEN s.project_state = 'project' THEN j.display_name || CASE WHEN j.display_state = 'active' THEN '' ELSE ' (removed)' END
          WHEN s.project_reason = 'projectless' THEN '${PROJECTLESS_LABEL}'
          WHEN s.project_state = 'not_reported' THEN coalesce(j.machine_label, 'A machine') || '${NOT_REPORTED_SUFFIX}'
        END AS project_label
      FROM pm_joined j
      CROSS JOIN LATERAL (SELECT
          CASE
            WHEN j.effective_project_basis = 'none' THEN 'no_project'
            WHEN j.resolution IS NULL THEN CASE WHEN j.reported THEN 'unknown' ELSE 'not_reported' END
            WHEN j.resolution = 'projectless' THEN 'no_project'
            WHEN j.app_project_id IS NOT NULL THEN 'project'
            ELSE 'unassigned'
          END AS project_state,
          CASE
            WHEN j.effective_project_basis = 'none' THEN 'no_project'
            WHEN j.resolution IS NULL THEN CASE WHEN j.reported THEN 'unknown' ELSE 'not_reported' END
            WHEN j.resolution = 'projectless' THEN 'projectless'
            WHEN j.app_project_id IS NOT NULL THEN 'project'
            WHEN j.resolution IN ('outside_roots', 'no_folder') THEN j.resolution
            ELSE 'missing_project'
          END AS project_reason) s
    )`;

/** The Settings > Projects "Not in a project" buckets, in display order. */
export const PROJECT_REASONS = ['projectless', 'outside_roots', 'no_folder', 'no_project', 'missing_project', 'not_reported', 'unknown'] as const;
export type ProjectReason = typeof PROJECT_REASONS[number];
