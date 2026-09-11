"use client"

import * as React from "react"
import { TriangleAlertIcon, CircleCheckIcon, InfoIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import {
  ClaimBadge, Column, CopyButton, DataTable, DiffLine, DiffView, EmptyState, Field, KitCard,
  Meter, ProviderDot, Receipt, ReceiptStep, Reconciliation, SeverityBadge, SparkBars, Stat,
  StatGroup, StatusBadge, TerminalBlock,
} from "@/components/kit"

/* ---------------------------------------------------------------- example data */

type LedgerRow = {
  id: string
  provider: string
  tone: 1 | 2 | 3
  model: string
  cached: number | null
  fresh: number
  out: number
  cost: number
}

const LEDGER: LedgerRow[] = [
  { id: "opus", provider: "Anthropic", tone: 1, model: "claude-opus-5", cached: 1284902, fresh: 41338, out: 92104, cost: 18.42 },
  { id: "sonnet", provider: "Anthropic", tone: 1, model: "claude-sonnet-5", cached: 3902118, fresh: 128440, out: 210882, cost: 11.07 },
  { id: "haiku", provider: "Anthropic", tone: 1, model: "claude-haiku-4.5", cached: 812400, fresh: 19006, out: 40210, cost: 0.94 },
  { id: "gpt", provider: "OpenAI", tone: 3, model: "gpt-5.2", cached: null, fresh: 88201, out: 31447, cost: 4.96 },
  { id: "gpt-pre", provider: "OpenAI", tone: 3, model: "gpt-5.2-20260214-preview-extended-reasoning", cached: null, fresh: 12004, out: 6220, cost: 1.02 },
  { id: "gemini", provider: "Google", tone: 2, model: "gemini-3-pro", cached: null, fresh: 30876, out: 5784, cost: 0.86 },
]

const n = (v: number | null) => (v === null ? "—" : v.toLocaleString())
const usd = (v: number) => v.toFixed(2)

const BURN = [18, 12, 9, 7, 6, 11, 24, 38, 47, 52, 44, 61, 58, 72, 100, 81, 66, 49, 37, 28, 22, 17, 14, 19]

const DIFF: DiffLine[] = [
  { kind: "fold", count: 14 },
  { kind: "context", oldLine: 18, newLine: 18, text: '  "permissions": {' },
  { kind: "context", oldLine: 19, newLine: 19, text: '    "allow": [' },
  { kind: "context", oldLine: 20, newLine: 20, text: '      "Read(**)",' },
  { kind: "del", oldLine: 21, text: '      "Bash(npm run test)",' },
  { kind: "add", newLine: 21, text: '      "Bash(npm run *)",' },
  { kind: "add", newLine: 22, text: '      "Bash(git push *)",' },
  { kind: "move", oldLine: 23, newLine: 23, text: '      "WebFetch(docs.anthropic.com)"', note: "moved from deny" },
  { kind: "context", oldLine: 24, newLine: 24, text: "    ]," },
  { kind: "del", oldLine: 26, text: '      "Read(./.env)"' },
  { kind: "fold", count: 31 },
]

const FINDINGS = [
  { id: "npc", rule: "no-progress-cycle", severity: "high" as const, detail: "r-8841 · turns 12–16 · 4 iterations, no tool result changed" },
  { id: "retry", rule: "identical-retry-after-failure", severity: "high" as const, detail: "r-8841 · turns 19, 21, 23 · same argv after exit 2" },
  { id: "ctx", rule: "context-growth-runaway", severity: "medium" as const, detail: "r-8839 · turns 4–16 · 41k → 186k tokens" },
  { id: "big", rule: "oversized-tool-result", severity: "low" as const, detail: "r-8837 · turn 7 · Read returned 412 KB" },
  { id: "rep", rule: "tool-result-repeat", severity: "incomplete" as const, detail: "r-8840 · needs tool_result.hash — the export does not carry it" },
]

/* ---------------------------------------------------------------- page */

export default function DesignSystemPage() {
  const [selected, setSelected] = React.useState("haiku")
  const [finding, setFinding] = React.useState("npc")
  const [newsOn, setNewsOn] = React.useState(false)
  const [usageOn, setUsageOn] = React.useState(true)

  const columns: Column<LedgerRow>[] = [
    {
      id: "provider",
      header: "Provider",
      sortValue: (r) => r.provider,
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <ProviderDot tone={r.tone} />
          {r.provider}
        </span>
      ),
      footer: "Total · 6 models",
    },
    {
      id: "model",
      header: "Model",
      sortValue: (r) => r.model,
      cell: (r) => (
        <span className="block max-w-[22ch] truncate font-mono" title={r.model}>
          {r.model}
        </span>
      ),
    },
    { id: "cached", header: "Cached in", numeric: true, sortValue: (r) => r.cached ?? -1, cell: (r) => n(r.cached), footer: "5,999,420" },
    { id: "fresh", header: "Fresh in", numeric: true, sortValue: (r) => r.fresh, cell: (r) => n(r.fresh), footer: "319,865" },
    { id: "out", header: "Out", numeric: true, sortValue: (r) => r.out, cell: (r) => n(r.out), footer: "386,647" },
    { id: "cost", header: "Cost USD", numeric: true, sortValue: (r) => r.cost, cell: (r) => usd(r.cost), footer: "37.27" },
  ]

  return (
    <main className="mx-auto grid max-w-[1200px] gap-10 px-6 py-10">
      <header className="grid gap-2">
        <h1 className="text-2xl font-bold tracking-tight">kit-board design system</h1>
        <p className="text-muted-foreground max-w-[72ch] text-sm leading-relaxed">
          shadcn primitives on a near-black ground with a green accent. Every corner derives from a
          single <code className="font-mono text-xs">--radius</code> of 0.5rem, so nothing drifts out
          of the scale. Primitives live in <code className="font-mono text-xs">components/ui</code>;
          the product-specific composites built on top of them live in{" "}
          <code className="font-mono text-xs">components/kit</code>.
        </p>
      </header>

      {/* ---------------------------------------------------------- foundations */}
      <Section title="Foundations" description="Surfaces run one hue, separated by lightness only.">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-px overflow-hidden rounded-[var(--radius-card)] border">
          {[
            ["background", "#070807"], ["sidebar", "#0a0b0a"], ["card", "#0d0e0d"], ["muted", "#121413"],
            ["secondary", "#161817"], ["accent", "#1d1f1e"], ["border", "#1f2120"], ["input", "#2a2d2b"],
            ["primary", "#63bc93"], ["destructive", "#d66a5b"], ["warning", "#cfa24f"], ["info", "#7e90cc"],
          ].map(([name, hex]) => (
            <div key={name} className="bg-card">
              <div className="h-12" style={{ background: hex }} />
              <div className="p-2">
                <p className="text-xs font-semibold">{name}</p>
                <p className="text-muted-foreground font-mono text-[11px]">{hex}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          {["sm", "md", "lg", "xl"].map((r) => (
            <figure key={r} className="grid justify-items-center gap-2">
              <div className="bg-secondary border-primary h-10 w-16 border-2" style={{ borderRadius: `var(--radius-${r})` }} />
              <figcaption className="text-muted-foreground font-mono text-[11px]">{r}</figcaption>
            </figure>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------- primitives */}
      <Section title="Primitives" description="Vendored shadcn components, unmodified except for the badge tones this product needs.">
        <Card>
          <CardHeader><CardTitle className="text-base">Button</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Row label="variant">
              <Button>Run collector</Button>
              <Button variant="secondary">Open receipt</Button>
              <Button variant="outline">Copy path</Button>
              <Button variant="ghost">Dismiss</Button>
              <Button variant="destructive">Delete 84 summaries</Button>
              <Button variant="link">Read the rule</Button>
            </Row>
            <Row label="size">
              <Button size="xs">xs</Button>
              <Button size="sm">sm</Button>
              <Button>default</Button>
              <Button size="lg">lg</Button>
              <Button size="icon" aria-label="Refresh">↻</Button>
            </Row>
            <Row label="state">
              <Button disabled>disabled</Button>
              <Button variant="outline" disabled>outline disabled</Button>
              <Button aria-invalid>aria-invalid</Button>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Badge</CardTitle>
            <CardDescription>Solid for standalone status, soft for dense rows.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Row label="solid">
              <Badge>default</Badge><Badge variant="secondary">secondary</Badge>
              <Badge variant="destructive">destructive</Badge><Badge variant="warning">warning</Badge>
              <Badge variant="info">info</Badge><Badge variant="outline">outline</Badge>
            </Row>
            <Row label="soft">
              <Badge variant="soft">soft</Badge><Badge variant="soft-destructive">soft-destructive</Badge>
              <Badge variant="soft-warning">soft-warning</Badge><Badge variant="soft-info">soft-info</Badge>
            </Row>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-base">Form</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <Field htmlFor="ds-name" label="Display name" help="Shown in the kit list and in every receipt.">
                <Input defaultValue="Usage — personal" />
              </Field>
              <Field htmlFor="ds-sched" label="Collection schedule" help="The board never calls a provider itself.">
                <Select defaultValue="6h">
                  <SelectTrigger id="ds-sched"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1h">Every hour</SelectItem>
                    <SelectItem value="6h">Every 6 hours</SelectItem>
                    <SelectItem value="day">Daily at 06:00 UTC</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field htmlFor="ds-path" label="Collector output path" error="Not writable. The collector runs as observatory; this path is owned by root.">
                <Input className="font-mono" defaultValue="~/.observatory/usage/" />
              </Field>
              <div className="border-border flex items-center justify-between gap-4 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-semibold">Keep unsettled rows</p>
                  <p className="text-muted-foreground text-xs">Rows the provider has not billed yet stay in the ledger.</p>
                </div>
                <Switch defaultChecked aria-label="Keep unsettled rows" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Overlays and feedback</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <Row label="overlay">
                <Dialog>
                  <DialogTrigger asChild><Button variant="outline">Disable News…</Button></DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Disable News?</DialogTitle>
                      <DialogDescription>
                        Fetching stops today. The 84 stored summaries stay readable, and your sources
                        and relevance criteria are kept. Re-enabling resumes from the day you turn it
                        back on.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose asChild><Button variant="ghost">Keep it on</Button></DialogClose>
                      <DialogClose asChild><Button>Disable News</Button></DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="outline">Actions</Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel>Run</DropdownMenuLabel>
                    <DropdownMenuItem>Re-run now<DropdownMenuShortcut>R</DropdownMenuShortcut></DropdownMenuItem>
                    <DropdownMenuItem>Copy run id<DropdownMenuShortcut>⌘C</DropdownMenuShortcut></DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive">Disable this kit</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Popover>
                  <PopoverTrigger asChild><Button variant="outline">Coverage</Button></PopoverTrigger>
                  <PopoverContent className="text-sm">
                    <p className="font-semibold">Coverage</p>
                    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                      tool_result.hash present on 5 of 6 runs. The sixth is reported as incomplete
                      rather than clean.
                    </p>
                  </PopoverContent>
                </Popover>

                <Tooltip>
                  <TooltipTrigger asChild><Button variant="ghost">Hover me</Button></TooltipTrigger>
                  <TooltipContent>Read from the Mar 11 receipt</TooltipContent>
                </Tooltip>
                <CopyButton value="agentlint analyze runs/r-8841.jsonl" label="Copy the command" variant="outline" />
              </Row>

              <Separator />

              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Result failed validation</AlertTitle>
                <AlertDescription>
                  entries[112].cost_usd was null where the schema expects a number. Nothing was written.
                </AlertDescription>
              </Alert>
              <Alert variant="warning">
                <InfoIcon />
                <AlertTitle>Two sources disagree about March</AlertTitle>
                <AlertDescription>The difference is $0.58 across 14 unsettled requests.</AlertDescription>
              </Alert>
              <Alert variant="success">
                <CircleCheckIcon />
                <AlertTitle>Validated</AlertTitle>
                <AlertDescription>1,284 entries against usage.schema.json v3, 0 rejected.</AlertDescription>
              </Alert>

              <Row label="loading">
                <Skeleton className="h-8 w-28" />
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-8 w-20" />
              </Row>
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* ---------------------------------------------------------- kit composites */}
      <Section title="Kit components" description="Product-specific pieces composed from the primitives above.">
        <Card className="gap-0 py-0 overflow-hidden">
          <StatGroup className="border-border border-b">
            <Stat label="Allowance" value="2.14M" caption="of 5.00M · resets in 3 days" />
            <Stat label="Projected" value="3.16M" caption="1.84M under at current rate" tone="primary" />
            <Stat label="Burn, 24 h" value="14.2k" caption="1.45× the 28-day average" />
            <Stat label="Cost, March" value="$37.27" caption="console reads $36.69" />
            <Stat label="Difference" value="$0.58" caption="14 requests unsettled" tone="warning" />
          </StatGroup>
          <div className="grid gap-6 p-4 md:grid-cols-2">
            <div className="grid gap-2">
              <p className="text-sm font-semibold">Allowance</p>
              <Meter used={2.14} projected={3.16} limit={5} formatValue={(v) => `${v.toFixed(2)}M`} />
            </div>
            <div className="grid gap-2">
              <p className="text-sm font-semibold">Burn rate, last 24 h</p>
              <SparkBars values={BURN} average={9.8 * (100 / 31.4)} axis={["06:00", "12:00", "18:00", "06:00"]} formatValue={(v) => `${((v * 31.4) / 100).toFixed(1)}k`} />
            </div>
          </div>
        </Card>

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">March 2026</CardTitle>
            <CardDescription>As the collector recorded them, not as the console bills them.</CardDescription>
            <CardAction><Badge variant="soft-warning">Δ $0.58</Badge></CardAction>
          </CardHeader>
          <DataTable
            columns={columns}
            rows={LEDGER}
            getRowId={(r) => r.id}
            selectedId={selected}
            onSelect={(r) => setSelected(r.id)}
            defaultSort={{ id: "cost", dir: "desc" }}
          />
          <div className="border-border text-muted-foreground border-t p-3 text-xs">
            Click or use arrow keys to move, Enter to select. Selected: <span className="font-mono">{selected}</span>
          </div>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Receipt</CardTitle>
              <CardDescription className="font-mono text-[11px]">usage-2026-03-11T06:00Z · 36.4 s</CardDescription>
              <CardAction><StatusBadge status="validated" /></CardAction>
            </CardHeader>
            <CardContent>
              <Receipt>
                <ReceiptStep state="ok" time="06:00:12">Collector read <b>3 sources</b> — console, usage export, proxy log</ReceiptStep>
                <ReceiptStep state="ok" time="06:00:41">Validated against <b>usage.schema.json</b> v3 — 1,284 entries, 0 rejected</ReceiptStep>
                <ReceiptStep state="ok" time="06:00:48">Wrote 2 artifacts, replaced the March file</ReceiptStep>
              </Receipt>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Receipt — failed</CardTitle>
              <CardDescription className="font-mono text-[11px]">usage-2026-03-10T06:00Z · 29.1 s</CardDescription>
              <CardAction><StatusBadge status="failed" /></CardAction>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Receipt>
                <ReceiptStep state="ok" time="06:00:09">Collector read <b>3 sources</b></ReceiptStep>
                <ReceiptStep state="fail" time="06:00:38"><b>entries[112].cost_usd</b> — schema expects a number, source sent <b>null</b></ReceiptStep>
                <ReceiptStep state="skip">Nothing was written. The Mar 9 file is still current.</ReceiptStep>
              </Receipt>
              <div className="flex flex-wrap gap-2">
                <Button size="sm">Re-run collector</Button>
                <Button size="sm" variant="outline">Open entry 112</Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">Two sources disagree about March</CardTitle>
            <CardDescription>Both are shown and the gap is named. Neither is averaged away.</CardDescription>
            <CardAction><Badge variant="soft-warning">not reconciled</Badge></CardAction>
          </CardHeader>
          <Reconciliation
            className="border-border border-t"
            sources={[
              { label: "Provider console", value: "$36.69", detail: "read 06:00:12 · 1,270 settled · authoritative for billing" },
              { label: "Local collector", value: "$37.27", detail: "read 06:00:12 · 1,284 recorded · counted as they leave" },
            ]}
            difference={{ label: "Difference", value: "$0.58", detail: "14 requests, Mar 9 02:00–03:00 UTC, not yet settled" }}
            actions={<>
              <Button size="sm" variant="outline">Show the 14 requests</Button>
              <Button size="sm" variant="ghost">Accept the console figure</Button>
            </>}
          />
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="p-4">
              <CardTitle className="text-base">Findings</CardTitle>
              <CardDescription>4 rules fired across 6 runs · 1,284 turns</CardDescription>
              <CardAction><Badge variant="soft-destructive">exit 2</Badge></CardAction>
            </CardHeader>
            <div className="border-border border-t">
              {FINDINGS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => f.severity !== "incomplete" && setFinding(f.id)}
                  disabled={f.severity === "incomplete"}
                  aria-current={finding === f.id}
                  className="border-border hover:bg-accent aria-[current=true]:bg-primary/10 aria-[current=true]:shadow-[inset_2px_0_0_var(--primary)] focus-visible:ring-ring/50 flex w-full flex-wrap items-center gap-3 border-b px-4 py-3 text-left outline-none last:border-b-0 focus-visible:ring-[3px] disabled:opacity-50"
                >
                  <span className="min-w-[170px] flex-1">
                    <span className="block font-mono text-sm font-medium">{f.rule}</span>
                    <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">{f.detail}</span>
                  </span>
                  <SeverityBadge severity={f.severity} />
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-mono text-base font-medium">no-progress-cycle</CardTitle>
              <CardDescription>turns 12–16 · runs/r-8841.jsonl</CardDescription>
              <CardAction><ClaimBadge tier="proven" /></CardAction>
            </CardHeader>
            <CardContent className="grid gap-3">
              <pre className="bg-muted text-muted-foreground overflow-x-auto rounded-lg border p-3 font-mono text-[11px] leading-relaxed">
{`turn 12  Bash(pytest -q)    → exit 1, 240 B, sha 4f1a…c093
turn 13  Read(conftest.py)  → 1.2 KB,  sha 91be…07d2
turn 14  Bash(pytest -q)    → exit 1, 240 B, sha 4f1a…c093
turn 15  Read(conftest.py)  → 1.2 KB,  sha 91be…07d2
turn 16  Bash(pytest -q)    → exit 1, 240 B, sha 4f1a…c093`}
              </pre>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Four turns produced two distinct results, repeated. No file was written between them,
                so nothing the agent did could have changed the outcome.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <DiffView
            file=".claude/settings.json"
            revisions="a3f19c2 → 7b04e18"
            lines={DIFF}
            verdict={
              <Receipt>
                <ReceiptStep state="ok" time="projected"><b>npm run *</b> replaces <b>npm run test</b> — every script is runnable now.</ReceiptStep>
                <ReceiptStep state="fail" time="proven"><b>Read(./.env)</b> left the deny list; <b>Read(**)</b> already matches it.</ReceiptStep>
              </Receipt>
            }
          />
          <TerminalBlock
            caption="agentlint · local, offline, deterministic"
            command="agentlint analyze runs/r-8841.jsonl --rules default"
            exitCode={2}
            note="a high-severity rule fired"
          >
{`$ agentlint analyze runs/r-8841.jsonl --rules default
read 6 runs · 1,284 turns · coverage 5 of 6

r-8841  no-progress-cycle              high    turns 12–16
r-8841  identical-retry-after-failure  high    turns 19, 21, 23
r-8839  context-growth-runaway         medium  41k → 186k
r-8837  oversized-tool-result          low     412 KB (Read)
r-8840  tool-result-repeat             incomplete

4 rules fired across 6 runs`}
          </TerminalBlock>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <KitCard
            name="Usage" cadence="hourly · 3 provider sources" enabled={usageOn} onEnabledChange={setUsageOn}
            description="Reads three provider sources, reconciles them, and keeps monthly history."
            figures={[
              { label: "This month", value: "6.71M" },
              { label: "Cost", value: "$37.27" },
              { label: "Unread", value: "12", tone: "primary" },
            ]}
            status={<Badge variant="soft-warning">sources differ</Badge>}
            actions={<Button size="xs" variant="ghost">Open</Button>}
          />
          <KitCard
            name="News" cadence="disabled Mar 2" enabled={newsOn} onEnabledChange={setNewsOn}
            description="Fetching stopped. 84 summaries from 9 sources stay readable and searchable; sources and criteria are kept."
            figures={[{ label: "Summaries kept", value: "84" }, { label: "Sources", value: "9" }]}
            status={<StatusBadge status="disabled" />}
            actions={<Button size="xs" variant="ghost">Read the 84</Button>}
          />
          <KitCard
            name="Assistant" cadence="on demand" enabled
            description="Configured reviews of email and work systems. Enabled and connected — nothing appears until you run it from your own agent setup."
            status={<StatusBadge status="never-run" />}
            actions={<Button size="xs" variant="ghost">Show the command</Button>}
          />
        </div>

        <Tabs defaultValue="empty">
          <TabsList>
            <TabsTrigger value="empty">Empty</TabsTrigger>
            <TabsTrigger value="clean">Clean run</TabsTrigger>
          </TabsList>
          <TabsContent value="empty">
            <EmptyState
              title="No runs yet"
              description="Nothing has published to this kit. The board waits for results — it does not start work."
              actions={<>
                <Button size="sm">Copy the publish command</Button>
                <Button size="sm" variant="ghost">Read the setup</Button>
              </>}
            />
          </TabsContent>
          <TabsContent value="clean">
            <EmptyState
              tone="success"
              icon={<CircleCheckIcon />}
              title="No findings"
              description="0 rules fired across 6 runs with full coverage. This is the result, not an absence."
              actions={<Button size="sm" variant="outline">See the 12 rules that ran</Button>}
            />
          </TabsContent>
        </Tabs>
      </Section>
    </main>
  )
}

/* ---------------------------------------------------------------- helpers */

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground w-14 shrink-0 font-mono text-[11px]">{label}</span>
      {children}
    </div>
  )
}
