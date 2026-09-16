import { InfoIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, Disclosure, Stat, StatGroup, type Column } from '@/components/kit';
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

/** One cell of a divided band, not a card inside a card: three readings of one estimate. */
function ImpactSummary({ label, value, range, comparison }: { label: string; value: string; range: string; comparison: React.ReactNode }) {
  return (
    <div className="border-border grid content-start gap-2 border-t p-4 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0">
      <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">{label} · planning</span>
      <span className="font-mono text-2xl leading-none font-medium tracking-tight tabular-nums">{value}</span>
      <p className="text-muted-foreground text-sm leading-relaxed">{comparison}</p>
      <span className="text-muted-foreground font-mono text-[10.5px] leading-snug">{range} scenario comparison</span>
    </div>
  );
}

/** A suggestion reads as a spec sheet with one call to action - the estimate above stays untouched by it. */
function ActionCell({ action }: { action: (typeof ENVIRONMENTAL_ACTIONS)[number] }) {
  const terms: [string, React.ReactNode][] = [
    ['Unit', action.unit],
    ['Availability', action.availability],
    ['Geography', action.geography],
    ['Delivery / evidence', `${action.delivery} ${action.evidence}`],
  ];
  return (
    <div className="border-border grid content-start gap-3 border-t p-4 text-xs first:border-t-0 lg:border-t-0 lg:border-l lg:first:border-l-0">
      <div className="grid gap-1.5">
        <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">{action.category}</span>
        <h4 className="text-sm leading-snug font-semibold">{action.title}</h4>
      </div>
      <p className="text-muted-foreground leading-relaxed">{action.purpose}</p>
      <dl className="grid gap-1.5">
        {terms.map(([term, detail]) => (
          <div key={term} className="flex gap-3">
            <dt className="text-muted-foreground w-24 shrink-0 leading-relaxed">{term}</dt>
            <dd className="min-w-0 flex-1 leading-relaxed">{detail}</dd>
          </div>
        ))}
      </dl>
      <p className="text-warning leading-relaxed">{action.caveat}</p>
      <Button variant="outline" size="sm" className="mt-1 justify-self-start" asChild>
        <a href={action.href} target="_blank" rel="noreferrer noopener">{action.action}</a>
      </Button>
    </div>
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
    <Card className="gap-0 overflow-hidden py-0" aria-label="Environmental impact">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Environmental impact</CardTitle>
        <CardDescription className="max-w-[90ch]">Inference-equivalent scenarios for the same selected activity and filters. These are modeled physical quantities, not measurements from provider datacenters.</CardDescription>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Badge variant="outline">method {estimate.methodology_version}</Badge>
          <Badge variant="soft-warning">low-confidence scenarios</Badge>
          {estimate.coverage.calls_without_class > 0 ? <Badge variant="soft-warning">{exactTokens(estimate.coverage.calls_without_class)} calls unestimated</Badge> : <Badge variant="soft">all headline calls classified</Badge>}
        </div>
        <p className="text-muted-foreground max-w-[90ch] pt-2 text-sm leading-relaxed">
          The planning values apply published per-call reference factors to classified source-month cohorts. Actual hardware, datacenter location, grid mix, cooling, and water source are unknown. The floor-to-upper span compares scenarios; it is not a confidence interval or a guarantee that the real footprint lies inside it.
        </p>
      </CardHeader>

      <div className="border-border grid border-t md:grid-cols-3">
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

      <StatGroup className="border-border border-t">
        <Stat label="Estimated calls" value={exactTokens(estimate.coverage.calls_estimated)} caption={`${percent(estimate.coverage.calls_headline ? estimate.coverage.calls_estimated / estimate.coverage.calls_headline : null)} of ${exactTokens(estimate.coverage.calls_headline)} headline calls`} />
        <Stat label="Cohorts" value={exactTokens(estimate.basis.cohorts.length)} caption={`${estimate.coverage.cohorts_provisional} provisional · ${estimate.coverage.cohorts_stored} stored estimates`} />
        <Stat label="Planning class basis" value={estimate.basis.average_raw_tokens_per_call === null ? '—' : `${quantity(estimate.basis.average_raw_tokens_per_call, 0)} tokens/call`} caption={`threshold ${exactTokens(estimate.basis.planning_context_threshold_tokens_per_call)} · source-month classes do not change under filters`} />
      </StatGroup>

      <section aria-labelledby="environment-actions" className="grid">
        <div className="border-border grid gap-4 border-t p-4">
          {estimate.coverage.calls_without_class > 0 ? (
            <Alert variant="warning">
              <InfoIcon />
              <AlertTitle>{exactTokens(estimate.coverage.calls_without_class)} headline calls lack the call/cohort evidence this method requires</AlertTitle>
              <AlertDescription>They are excluded from the footprint, not filled from an unfiltered monthly estimate. {estimate.coverage.note}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-1">
            <h3 id="environment-actions" className="text-sm font-semibold">Actions you can take</h3>
            <p className="text-muted-foreground max-w-[90ch] text-xs leading-relaxed">Suggestions stay separate from the estimate. Opening a destination, ordering support, promised delivery, certificate retirement, and completed removal are different states; none changes the footprint displayed above.</p>
          </div>
          <Alert>
            <AlertTitle>Reduce unnecessary work · modeled 10%</AlertTitle>
            <AlertDescription>
              <p className="text-foreground font-medium">Avoid about {quantity(reduction.calls_avoided, 1)} comparable calls</p>
              <p>Under the same workload mix and planning factors, that models savings of {energy(reduction.energy_kwh_avoided)}, {water(reduction.direct_water_liters_avoided)}, and {carbon(reduction.operational_co2_kg_avoided)}. A changed workload mix can produce different savings.</p>
            </AlertDescription>
          </Alert>
        </div>
        <div className="border-border grid border-t lg:grid-cols-3">
          {ENVIRONMENTAL_ACTIONS.map(action => <ActionCell key={action.key} action={action} />)}
        </div>
        <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed">Program details checked {checked}. Recheck availability, terms, project, price, and certificate or delivery evidence at the destination before acting. The upper operational scenario is {carbon(estimate.compensation_planning.operational_co2_kg_to_cover)}; it is a conservative planning quantity, not a neutrality claim or proof of completed compensation.</p>
      </section>

      <div className="border-border border-t p-4">
        <Disclosure title="Scenario factors, scope, methodology, and sources" contentClassName="text-muted-foreground grid gap-4 text-xs leading-relaxed">
          <p>{estimate.scope}</p>
          <p>{estimate.basis.classification_unit}. Method versions represented: {estimate.methodology_versions.join(', ') || estimate.methodology_version}.</p>
          {estimate.scenarios.length ? <DataTable className="max-h-72 overflow-auto" columns={scenarioColumns} rows={estimate.scenarios} getRowId={row => row.key} /> : null}
          <ul className="grid gap-1">{estimate.assumptions.map(assumption => <li key={assumption}>• {assumption}</li>)}</ul>
          <div className="flex flex-wrap gap-2">{estimate.sources.map(source => <Button key={source.url} variant="outline" size="xs" asChild><a href={source.url} target="_blank" rel="noreferrer noopener">{source.label}</a></Button>)}</div>
        </Disclosure>
      </div>
    </Card>
  );
}
