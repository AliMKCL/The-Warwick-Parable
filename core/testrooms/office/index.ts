import { balloons } from './balloons';
import { canteen } from './canteen';
import { coffee } from './coffee';
import { loan } from './loan';
import { lockdown } from './lockdown';
import type { OfficeTaskId, OfficeTaskModule } from './module';
import { pitch } from './pitch';
import { renumbered } from './renumbered';

/**
 * Office versions of tasks 6 to 11 (PR #6), one module each. Each one is a
 * test in the run's pool (core/testrooms/registry.ts, via ./adapter.ts): put
 * its id in data/layout.json `pool` to draw it.
 */
export const OFFICE_MODULES: Record<OfficeTaskId, OfficeTaskModule> = { balloons, coffee, canteen, renumbered, pitch, loan, lockdown };

export const isOfficeModule = (id: string): id is OfficeTaskId => id in OFFICE_MODULES;

export type { OfficeTaskId, OfficeTaskModule } from './module';
