import { InfoIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DataTable, Stat, StatGroup, type Column } from '@/components/kit';
import { ENVIRONMENTAL_ACTIONS, ENVIRONMENTAL_ACTIONS_VERIFIED_AT } from '@/lib/environmental-actions';
import type { EnvironmentalEstimate } from '@/lib/environmental-estimate';
import { exactTokens, percent } from '@/lib/usage-view';

function quantity(value: number, maximumFractionDigits = 3) {
  if (value === 0) return '0';
  if (Math.abs(value) < 0.001) return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return value.toLocaleString('en-US', { maximumFractionDigits });
}
export const energy = (value: number) => value < 1 ? `${quantity(value * 1_000)} Wh` : `${quantity(value)} kWh`;
export const water = (value: number) => value < 1 ? `${quantity(value * 1_000)} mL` : `${quantity(value)} L`;
export const carbon = (value: number) => value < 1 && value > 0 ? `${quantity(value * 1_000)} g CO₂e` : `${quantity(value)} kg CO₂e`;

function ImpactSummary({ label, value, range, comparison }: { label: string; value: string; range: string; comparison: React.ReactNode }) {
  return (
    <Card size="sm" className="gap-3 py-4 shadow-none">
      <CardHeader className="px-4">
        <CardDescription className="text-[10px] font-semibold tracking-wider uppercase">{label} · planning</CardDescription>
        <CardTitle className="font-mono text-2xl leading-none font-medium tracking-tight tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        <p className="text-muted-foreground text-sm leading-relaxed">{comparison}</p>
        <span className="text-muted-foreground font-mono text-[10px]">{range} scenario comparison</span>
      </CardContent>
    </Card>
  );
}

/** USG-020: the selected scope's physical estimates stay separate from suggested actions. */
export function EnvironmentalImpact({ estimate }: { estimate: EnvironmentalEstimate }) {
  const comparisons = estimate.comparisons_at_planning_scenario;
  const reduction = estimate.reduction_if_calls_drop_10_percent;
  const checked = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ENVIRONMENTAL_ACTIONS_VERIFIED_AT}T00:00:00Z`));
  const scenarioColumns: Column<EnvironmentalEstimate['scenarios'][number]>[] = [
    { id: 'label', header: 'Scenario', sortValue: row => row.label, cell: row => row.label },
    { id: 'unit', header: 'Unit', sortValue: row => row.unit, cell: row => <span className="font-mono text-xs">{row.unit}</span> },
    { id: 'factor', header: 'Factor', sortValue: row => row.factor, cell: row => row.factor },
  ];
  return (
    <Card aria-label="Environmental impact">
      <CardHeader>
        <CardTitle className="text-base">Environmental impact</CardTitle>
        <CardDescription>Inference-equivalent scenarios for the same selected activity and filters. These are modeled physical quantities, not measurements from provider datacenters.</CardDescription>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge variant="outline">method {estimate.methodology_version}</Badge>
          <Badge variant="soft-warning">low-confidence scenarios</Badge>
          {estimate.coverage.calls_without_class > 0 ? <Badge variant="soft-warning">{exactTokens(estimate.coverage.calls_without_class)} calls unestimated</Badge> : <Badge variant="soft">all headline calls classified</Badge>}
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        <p className="text-muted-foreground max-w-[90ch] text-sm leading-relaxed">
          The planning values apply published per-call reference factors to classified source-month cohorts. Actual hardware, datacenter location, grid mix, cooling, and water source are unknown. The floor-to-upper span compares scenarios; it is not a confidence interval or a guarantee that the real footprint lies inside it.
        </p>

        <div className="grid gap-4 md:grid-cols-3">
          <ImpactSummary label="Electricity" value={energy(estimate.energy_kwh.planning)}
            range={`${energy(estimate.energy_kwh.efficient_production_floor)} – ${energy(estimate.energy_kwh.long_context_upper)}`}
            comparison={<>About <b className="text-foreground">{quantity(comparisons.us_home_days_of_electricity)}</b> U.S. home-days or <b className="text-foreground">{quantity(comparisons.smartphone_full_charges, 0)}</b> smartphone charges.</>} />
          <ImpactSummary label="Direct water" value={water(estimate.direct_water_liters.planning)}
            range={`${water(estimate.direct_water_liters.efficient_production_floor)} – ${water(estimate.direct_water_liters.long_context_upper)}`}
            comparison={<>About <b className="text-foreground">{quantity(comparisons.average_showers)}</b> average eight-minute showers.</>} />
          <ImpactSummary label="Operational carbon" value={carbon(estimate.operational_co2_kg.planning_us_grid)}
            range={`${carbon(estimate.operational_co2_kg.clean_energy_floor)} – ${carbon(estimate.operational_co2_kg.long_context_us_grid)}`}
            comparison={<>Comparable to <b className="text-foreground">{quantity(comparisons.average_gasoline_vehicle_miles)}</b> average gasoline-vehicle miles; <b className="text-foreground">{quantity(comparisons.urban_tree_seedlings_grown_10_years)}</b> tree seedlings grown for ten years is another educational equivalent, not an offset.</>} />
        </div>

        <StatGroup className="border-border rounded-md border">
          <Stat label="Estimated calls" value={exactTokens(estimate.coverage.calls_estimated)} caption={`${percent(estimate.coverage.calls_headline ? estimate.coverage.calls_estimated / estimate.coverage.calls_headline : null)} of ${exactTokens(estimate.coverage.calls_headline)} headline calls`} />
          <Stat label="Cohorts" value={exactTokens(estimate.basis.cohorts.length)} caption={`${estimate.coverage.cohorts_provisional} provisional · ${estimate.coverage.cohorts_stored} stored estimates`} />
          <Stat label="Planning class basis" value={estimate.basis.average_raw_tokens_per_call === null ? '—' : `${quantity(estimate.basis.average_raw_tokens_per_call, 0)} tokens/call`} caption={`threshold ${exactTokens(estimate.basis.planning_context_threshold_tokens_per_call)} · source-month classes do not change under filters`} />
        </StatGroup>

        {estimate.coverage.calls_without_class > 0 ? (
          <Alert variant="warning">
            <InfoIcon />
            <AlertTitle>{exactTokens(estimate.coverage.calls_without_class)} headline calls lack the call/cohort evidence this method requires</AlertTitle>
            <AlertDescription>They are excluded from the footprint, not filled from an unfiltered monthly estimate. {estimate.coverage.note}</AlertDescription>
          </Alert>
        ) : null}

        <section className="grid gap-4" aria-labelledby="environment-actions">
          <div className="grid gap-1">
            <h3 id="environment-actions" className="text-sm font-semibold">Actions you can take</h3>
            <p className="text-muted-foreground text-xs leading-relaxed">Suggestions stay separate from the estimate. Opening a destination, ordering support, promised delivery, certificate retirement, and completed removal are different states; none changes the footprint displayed above.</p>
          </div>
          <Alert>
            <AlertTitle>Reduce unnecessary work · modeled 10%</AlertTitle>
            <AlertDescription>
              <p className="text-foreground font-medium">Avoid about {quantity(reduction.calls_avoided, 1)} comparable calls</p>
              <p>Under the same workload mix and planning factors, that models savings of {energy(reduction.energy_kwh_avoided)}, {water(reduction.direct_water_liters_avoided)}, and {carbon(reduction.operational_co2_kg_avoided)}. A changed workload mix can produce different savings.</p>
            </AlertDescription>
          </Alert>
          <div className="grid gap-4 lg:grid-cols-3">
            {ENVIRONMENTAL_ACTIONS.map(action => (
              <Card key={action.key} size="sm" className="gap-4 py-4 shadow-none">
                <CardHeader className="px-4">
                  <CardDescription className="text-[10px] font-semibold tracking-wider uppercase">{action.category}</CardDescription>
                  <CardTitle className="text-sm">{action.title}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 px-4 text-xs">
                  <p className="text-muted-foreground leading-relaxed">{action.purpose}</p>
                  <dl className="grid gap-2">
                    <div><dt className="text-muted-foreground">Unit</dt><dd>{action.unit}</dd></div>
                    <div><dt className="text-muted-foreground">Availability</dt><dd>{action.availability}</dd></div>
                    <div><dt className="text-muted-foreground">Geography</dt><dd>{action.geography}</dd></div>
                    <div><dt className="text-muted-foreground">Delivery / evidence</dt><dd>{action.delivery} {action.evidence}</dd></div>
                  </dl>
                  <p className="text-warning leading-relaxed">{action.caveat}</p>
                </CardContent>
                <CardFooter className="px-4">
                  <Button variant="outline" size="sm" asChild><a href={action.href} target="_blank" rel="noreferrer noopener">{action.action}</a></Button>
                </CardFooter>
              </Card>
            ))}
          </div>
          <p className="text-muted-foreground text-[11px]">Program details checked {checked}. Recheck availability, terms, project, price, and certificate or delivery evidence at the destination before acting. The upper operational scenario is {carbon(estimate.compensation_planning.operational_co2_kg_to_cover)}; it is a conservative planning quantity, not a neutrality claim or proof of completed compensation.</p>
        </section>

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-full justify-start">Scenario factors, scope, methodology, and sources</Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="text-muted-foreground mt-3 grid gap-4 text-xs leading-relaxed">
            <p>{estimate.scope}</p>
            <p>{estimate.basis.classification_unit}. Method versions represented: {estimate.methodology_versions.join(', ') || estimate.methodology_version}.</p>
            {estimate.scenarios.length ? (
              <div className="border-border overflow-auto rounded-lg border">
                <DataTable columns={scenarioColumns} rows={estimate.scenarios} getRowId={row => row.key} />
              </div>
            ) : null}
            <ul className="grid gap-1">{estimate.assumptions.map(assumption => <li key={assumption}>• {assumption}</li>)}</ul>
            <div className="flex flex-wrap gap-2">{estimate.sources.map(source => <Button key={source.url} variant="outline" size="xs" asChild><a href={source.url} target="_blank" rel="noreferrer noopener">{source.label}</a></Button>)}</div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
