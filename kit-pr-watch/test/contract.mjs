import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from '../contract/validate.mjs';

// The board's two contracts, as this kit's copies hold them. The runner sends each report as JSON, so a
// report is checked the same way: undefined fields drop out before the schema sees it.
const read = name => JSON.parse(readFileSync(new URL(`../contract/${name}`, import.meta.url), 'utf8'));
export const reportSchema = read('pr-watch-report-v1.schema.json');
export const workSchema = read('pr-watch-work-v1.schema.json');
export const workExample = read('pr-watch-work-v1.example.json');

export const reportIssues = report => validate(JSON.parse(JSON.stringify(report)), reportSchema).issues;
export function assertReportPasses(report) {
  assert.deepEqual(reportIssues(report), [], 'every report the runner builds passes pr-watch-report-v1');
}
