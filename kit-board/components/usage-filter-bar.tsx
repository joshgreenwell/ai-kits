'use client';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { ChevronDownIcon, XIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from 'cn';
import { PRESETS, type Preset } from '@/lib/usage-periods';
import {
  AGENT_SCOPES, PRESET_LABELS, PROJECT_STATES, PROJECT_STATE_LABELS, PROVIDER_OPTIONS, SURFACE_OPTIONS, activeFilterChips, clearedFilters, customRangeFromDates,
  hourlyAllowed, hourlyPossible, rangeDates, type FilterLabels, type ListFilterKey, type TokensFilters,
} from '@/lib/usage-view';

export type FilterOption = { value: string; label: string; hint?: string };
export type FilterVocabulary = {
  accounts: FilterOption[]; projects: FilterOption[]; machines: FilterOption[]; models: FilterOption[]; efforts: FilterOption[];
};

/**
 * The common Tokens filter bar (USG-017; the shared-filter half of USG-016). Time, accounts, and
 * projects stay visible; provider, model, effort, machine, surface, and agent scope sit under More
 * filters. Every selection is a list (OR within a dimension), dimensions AND together, and the whole
 * state lives in the private URL through the owner's onChange, so a link reproduces the view. One
 * display zone governs every date label; the range end is the query instant while a preset is live.
 */
export function UsageFilterBar({ filters, onChange, vocabulary, range, labels, disabled }: {
  filters: TokensFilters; onChange: (next: TokensFilters) => void; vocabulary: FilterVocabulary;
  range: { start: string; end: string; anchored_to_now: boolean } | null; labels: FilterLabels; disabled?: boolean;
}) {
  const chips = activeFilterChips(filters, labels);
  const moreCount = [filters.providers, filters.models, filters.efforts, filters.machines, filters.surfaces].reduce((count, list) => count + list.length, 0) + (filters.agent_scope === 'all' ? 0 : 1);
  // The date inputs follow the URL's own bounds for a custom range (so a shared link shows its dates) and the resolved range otherwise.
  const bounds = filters.preset === 'custom' && filters.start && filters.end ? { start: filters.start, end: filters.end } : range;
  const dates = bounds ? rangeDates(bounds, filters.timezone) : { start: '', end: '' };
  const [customStart, setCustomStart] = useState(dates.start), [customEnd, setCustomEnd] = useState(dates.end);
  useEffect(() => { setCustomStart(dates.start); setCustomEnd(dates.end); }, [dates.start, dates.end]);
  const hourly = range ? hourlyAllowed(range) : hourlyPossible(filters);
  const toggle = (key: ListFilterKey, value: string) => {
    const current = filters[key];
    onChange({ ...filters, [key]: current.includes(value) ? current.filter(v => v !== value) : [...current, value] });
  };
  // A range the API cannot serve hourly drops to daily here, before the request is made.
  const withRange = (next: TokensFilters): TokensFilters => ({ ...next, resolution: next.resolution === 'hour' && !hourlyPossible(next) ? 'day' : next.resolution });
  const applyCustom = () => {
    const resolved = customRangeFromDates(customStart, customEnd, filters.timezone);
    if (resolved) onChange(withRange({ ...filters, preset: 'custom', ...resolved }));
  };
  const choosePreset = (preset: Preset) => {
    if (preset === 'custom') { const resolved = customRangeFromDates(customStart, customEnd, filters.timezone); if (resolved) onChange(withRange({ ...filters, preset, ...resolved })); return; }
    onChange(withRange({ ...filters, preset, start: null, end: null }));
  };

  return (
    <section aria-label="Usage filters" className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5">
          <span className="text-muted-foreground text-xs font-semibold">Period</span>
          <Select value={filters.preset} onValueChange={value => choosePreset(value as Preset)} disabled={disabled}>
            <SelectTrigger aria-label="Period" className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">{PRESETS.map(preset => <SelectItem key={preset} value={preset}>{PRESET_LABELS[preset]}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        {filters.preset === 'custom' && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1.5"><span className="text-muted-foreground text-xs font-semibold">From</span><Input type="date" aria-label="Range start" value={customStart} onChange={e => setCustomStart(e.target.value)} className="w-[150px]" /></label>
            <label className="grid gap-1.5"><span className="text-muted-foreground text-xs font-semibold">Through</span><Input type="date" aria-label="Range end" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="w-[150px]" /></label>
            <Button type="button" size="sm" variant="outline" onClick={applyCustom} disabled={disabled}>Apply</Button>
          </div>
        )}
        <MultiSelect label="Accounts" placeholder="All accounts" options={vocabulary.accounts} selected={filters.accounts} onToggle={value => toggle('accounts', value)} disabled={disabled} />
        <MultiSelect label="Projects" placeholder="All projects" selected={filters.projects} onToggle={value => toggle('projects', value)} disabled={disabled}
          options={[...vocabulary.projects, ...PROJECT_STATES.map(state => ({ value: state, label: PROJECT_STATE_LABELS[state], hint: 'bucket' }))]} />
        <Popover>
          <PopoverTrigger asChild>
            {/* data-slot is how app/theme.css styles a control, so wearing the Select trigger's slot is
                what makes this the same control as Period - not a copy of its classes, which theme.css
                would override anyway. */}
            <FilterTrigger disabled={disabled} label={`More filters${moreCount ? `: ${moreCount} applied` : ''}`}>
              <span className="flex min-w-0 items-center gap-2">
                More filters
                {moreCount ? <Badge variant="soft" className="-my-0.5">{moreCount}</Badge> : null}
              </span>
            </FilterTrigger>
          </PopoverTrigger>
          <PopoverContent align="start" className="grid w-[22rem] max-w-[calc(100vw-2rem)] gap-4">
            <CheckList title="Provider" options={PROVIDER_OPTIONS.map(v => ({ value: v, label: v }))} selected={filters.providers} onToggle={v => toggle('providers', v)} />
            <CheckList title="Model" options={vocabulary.models} selected={filters.models} onToggle={v => toggle('models', v)} empty="Models appear once activity is in scope." />
            <CheckList title="Reasoning effort" options={vocabulary.efforts} selected={filters.efforts} onToggle={v => toggle('efforts', v)} empty="Effort is recorded on request detail only." />
            <CheckList title="Machine" options={vocabulary.machines} selected={filters.machines} onToggle={v => toggle('machines', v)} empty="No local collectors yet." />
            <CheckList title="Surface" options={SURFACE_OPTIONS.map(v => ({ value: v, label: v }))} selected={filters.surfaces} onToggle={v => toggle('surfaces', v)} />
            <div className="grid gap-1.5">
              <span className="text-muted-foreground text-xs font-semibold">Agent scope</span>
              <div className="flex gap-2">
                {AGENT_SCOPES.map(scope => (
                  <Button key={scope} type="button" size="sm" variant={filters.agent_scope === scope ? 'default' : 'outline'} aria-pressed={filters.agent_scope === scope} onClick={() => onChange({ ...filters, agent_scope: scope })}>
                    {scope === 'all' ? 'All' : scope === 'main' ? 'Main agent' : 'Subagents'}
                  </Button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">Effort, surface, project, and agent filters apply to request detail; the headline then covers that detail and says what it could not examine.</p>
            </div>
          </PopoverContent>
        </Popover>
        <label className="grid gap-1.5">
          <span className="text-muted-foreground text-xs font-semibold">Resolution</span>
          <Select value={filters.resolution} onValueChange={value => onChange({ ...filters, resolution: value as TokensFilters['resolution'] })} disabled={disabled}>
            <SelectTrigger aria-label="Resolution" className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="day">Daily</SelectItem>
              <SelectItem value="hour" disabled={!hourly}>Hourly{hourly ? '' : ' (14 days max)'}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-mono text-xs">
          {range ? `${new Date(range.start).toLocaleString('en-US', { timeZone: filters.timezone, month: 'short', day: 'numeric' })} to ${new Date(range.end).toLocaleString('en-US', { timeZone: filters.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${range.anchored_to_now ? ' (now)' : ''} · ` : ''}
          {filters.timezone}
        </span>
        {chips.map(chip => (
          <Badge key={chip.key} variant="soft" className="gap-1 pr-1">
            {chip.label}
            <button type="button" aria-label={`Remove ${chip.label}`} onClick={() => onChange(chip.next)} className="hover:bg-foreground/10 focus-visible:ring-ring/50 -mr-0.5 grid size-4 place-items-center rounded-full outline-none focus-visible:ring-[3px]">
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </Badge>
        ))}
        {chips.length ? <Button type="button" variant="ghost" size="sm" onClick={() => onChange(clearedFilters(filters))}>Clear all</Button> : <span className="text-muted-foreground text-xs">All accounts and projects</span>}
      </div>
    </section>
  );
}

/**
 * The one control the filter bar adds. app/theme.css dresses every select trigger in the app through
 * `[data-slot="select-trigger"]`, so carrying that slot is what keeps Accounts, Projects, and More
 * filters the same 44px, 14px, card-backed control as Period and Resolution. Copying Tailwind classes
 * out of the Select cannot do it: theme.css overrides those utilities, which is exactly how the first
 * attempt drifted to a 36px transparent button.
 */
const FilterTrigger = ({ className, label, disabled, children, ...props }: React.ComponentProps<'button'> & { label: string }) => (
  // data-slot sits AFTER the spread on purpose: PopoverTrigger's `asChild` passes its own
  // data-slot="popover-trigger" down as a prop, and whichever is written last wins. Before this the
  // popover's slot overwrote the select's and theme.css dressed nothing, which is how these drifted
  // back to a 46px transparent button while Period stayed the 44px card-backed one.
  <button type="button" role="combobox" aria-label={label} disabled={disabled} className={cn('w-fit', className)} {...props} data-slot="select-trigger" data-size="default">
    {children}
    <ChevronDownIcon aria-hidden="true" />
  </button>
);

function MultiSelect({ label, placeholder, options: given, selected, onToggle, disabled }: { label: string; placeholder: string; options: FilterOption[]; selected: string[]; onToggle: (value: string) => void; disabled?: boolean }) {
  const options = withSelected(given, selected);
  const summary = selected.length === 0 ? placeholder : selected.length === 1 ? (options.find(o => o.value === selected[0])?.label ?? selected[0]) : `${selected.length} selected`;
  return (
    <div className="grid gap-1.5">
      <span className="text-muted-foreground text-xs font-semibold">{label}</span>
      <Popover>
        {/* A Radix Select is single-select, so this stays a popover of checkboxes wearing the Select
            trigger's own slot, so it cannot drift from Period and Resolution. */}
        <PopoverTrigger asChild>
          <FilterTrigger className="w-[170px]" disabled={disabled} label={`${label}: ${summary}`}>
            <span className={cn('truncate', selected.length === 0 && 'text-muted-foreground')}>{summary}</span>
          </FilterTrigger>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[18rem] max-w-[calc(100vw-2rem)]">
          <CheckList title={label} options={options} selected={selected} onToggle={onToggle} empty="Nothing to choose yet." />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** A selected value always stays listed, even when the scope it narrowed no longer names it. */
const withSelected = (options: FilterOption[], selected: string[]): FilterOption[] => [...options, ...selected.filter(v => !options.some(o => o.value === v)).map(v => ({ value: v, label: v }))];

function CheckList({ title, options: given, selected, onToggle, empty }: { title: string; options: FilterOption[]; selected: string[]; onToggle: (value: string) => void; empty?: string }) {
  const options = withSelected(given, selected);
  return (
    <fieldset className="grid gap-1">
      <legend className="text-muted-foreground mb-1 text-xs font-semibold">{title}</legend>
      {options.length === 0 ? <p className="text-muted-foreground text-xs">{empty ?? 'No options.'}</p> : null}
      <div className="grid max-h-56 gap-1 overflow-auto">
        {options.map(option => (
          <label key={option.value} className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm">
            <Checkbox checked={selected.includes(option.value)} onCheckedChange={() => onToggle(option.value)} />
            <span className="truncate">{option.label}</span>
            {option.hint ? <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">{option.hint}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
