import type { ContractId, PublishedContract } from './kits';
import { prWatchContracts } from './pr-watch-contract';
import { reportContractRegistry } from './report-contracts';

/**
 * Every contract `npm run contracts` publishes: each report kind's request body, and the two the PR watch
 * runner speaks. usage-v2 is generated from the companion's own schema instead.
 */
export const contractRegistry = { ...reportContractRegistry, ...prWatchContracts } as const satisfies Partial<Record<ContractId, PublishedContract>>;
export type PublishedContractId = keyof typeof contractRegistry;

export const isPublishedContract = (id: string): id is PublishedContractId => Object.hasOwn(contractRegistry, id);
