import type { ReportKind } from '../contracts';
import { auditKit } from './audit';
import { boardEndpoints } from './board';
import { dailyTasksKit } from './daily-tasks';
import { prWatchKit } from './pr-watch';
import { readingsKit } from './readings';
import type { ContractId, Endpoint, Enforcement, KitManifest, KitReport, Schedule } from './types';
import { usageKit } from './usage';

export type { ContractId, Download, Endpoint, EndpointAuth, Enforcement, KitManifest, KitReport, PublishedContract, Schedule } from './types';
export { boardEndpoints };

/** The board's registry, in navigation order. `docs/kits.md` explains the boundary. */
export const kits = [usageKit, dailyTasksKit, readingsKit, auditKit, prWatchKit] as const satisfies readonly KitManifest[];
export type KitId = typeof kits[number]['id'];
/** Every scope a producer key can carry. */
export type ProducerKind = typeof kits[number]['producers'][number];
// The literal types above are for the type system; the lists below read the widened manifests.
const registry: readonly KitManifest[] = kits;

export const kitById = (id: string): KitManifest | undefined => registry.find(kit => kit.id === id);

/** Each report kind, the kit that produces it, and its payload contract. */
export const reportContracts: readonly (KitReport & { kit: KitId })[] = registry.flatMap(kit => kit.reports.map(report => ({ ...report, kit: kit.id as KitId })));
export const reportContract = (kind: ReportKind) => reportContracts.find(report => report.kind === kind)!;
export const enforcementFor = (kind: ReportKind): Enforcement => reportContract(kind).enforcement;

/**
 * The contracts a kit's endpoints name beyond its reports' payloads: a body the board checks, or the
 * shape of what it answers. Each id is listed once, at the first endpoint that names it.
 */
export function endpointContracts(kit: KitManifest): { id: ContractId; endpoint: Endpoint; direction: 'request' | 'response' }[] {
  const owned = new Set<ContractId>(kit.reports.map(report => report.contract));
  const found: { id: ContractId; endpoint: Endpoint; direction: 'request' | 'response' }[] = [];
  for (const endpoint of kit.endpoints) {
    for (const [id, direction] of [[endpoint.contract, 'request'], [endpoint.returns, 'response']] as const) {
      if (id && !owned.has(id) && !found.some(entry => entry.id === id)) found.push({ id, endpoint, direction });
    }
  }
  return found;
}

/** The report pages, one per kit that stores reports; standups read alongside the briefing. */
export const sections: { kind: ReportKind; title: string; path: string; empty: string }[] = registry.flatMap(kit =>
  kit.reports.length ? [{ kind: kit.reports[0].kind, title: kit.title, path: kit.page.path, empty: kit.page.empty }] : []);
export const sectionPath = (kind: ReportKind) => registry.find(kit => kit.reports.some(report => report.kind === kind))!.page.path;

export const schedules: readonly Schedule[] = registry.flatMap(kit => kit.schedules);

/** Every API route the board serves, with its owner. */
export const endpoints: readonly (Endpoint & { kit: KitId | 'board' })[] = [
  ...registry.flatMap(kit => kit.endpoints.map(endpoint => ({ ...endpoint, kit: kit.id as KitId }))),
  ...boardEndpoints.map(endpoint => ({ ...endpoint, kit: 'board' as const })),
];
