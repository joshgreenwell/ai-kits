"use client";

import { TokensOverviewLive } from "@/components/tokens-overview";
import { Workspace } from "@/components/workspace";

/**
 * Tokens: the filtered overview from `GET /api/usage-query`, and nothing else.
 *
 * The monthly analyzer reports used to render below it as a second, older view of the same usage,
 * with their own month and machine selectors. They were removed on 2026-09-22 so the page is the one
 * design. The reports themselves still arrive and are stored (`/api/reports`), and the overview still
 * merges a month's snapshot through the `usage_report_subjects` crosswalk when the hourly ledger has
 * nothing for it; only the separate section is gone.
 */
export default function TokensPage() {
  return (
    <Workspace width="dashboard">
      <TokensOverviewLive />
    </Workspace>
  );
}
