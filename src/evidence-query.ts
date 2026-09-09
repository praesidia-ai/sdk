import { assertIsoDateRange } from './client.js';
import { PraesidiaConfigError } from './errors.js';

/** Dates are UTC dates or explicitly offset timestamps in both SDK languages. */
export function assertEvidenceDateRange(from?: string, to?: string): void {
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && (
      typeof value !== 'string' ||
      value !== value.trim() ||
      !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)
    )) throw new PraesidiaConfigError(`${name} must be a UTC date or an ISO timestamp with a timezone`);
  }
  assertIsoDateRange(from, to);
}

export function assertBundleDateRange(from: string, to: string): void {
  if (!from || !to) throw new PraesidiaConfigError('from and to are required for a signed bundle');
  assertEvidenceDateRange(from, to);
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > 90 * 24 * 60 * 60 * 1000) {
    throw new PraesidiaConfigError('signed bundle range must be greater than zero and at most 90 days');
  }
}
