import { SCHEMA_TEXT } from './schema';
import type { ParseResult } from './types';

export interface PromptInput {
  goal: string;
  /** null = ongoing. */
  days: number | null;
  startDate: string;
  wake: string;
  sleep: string;
  workStart?: string;
  workEnd?: string;
  perDay: number;
  extra?: string;
}

/** The prompt copied on "Copy prompt & open ChatGPT". */
export function buildPlanPrompt(p: PromptInput): string {
  const length = p.days == null ? `Ongoing, starting ${p.startDate}.` : `${p.days} days from ${p.startDate}.`;
  const work = p.workStart && p.workEnd ? `, work ${p.workStart}–${p.workEnd}` : '';
  const lines = [
    'Create my notification plan in fais-moi format.',
    '',
    `Goal: ${p.goal.trim()}`,
    `Length: ${length}`,
    `My day: awake ${p.wake}–${p.sleep}${work}.`,
    `Limit: no more than ${p.perDay} reminders a day.`,
  ];
  if (p.extra?.trim()) lines.push(`Also: ${p.extra.trim()}`);
  lines.push(
    '',
    'Rules',
    '– Reply with ONE json code block, nothing else.',
    '– Follow the schema below exactly.',
    '– Write a different message for each day a reminder fires, up to 30, so none feel stale.',
    '– Messages under 90 characters. 24-hour times.',
    '',
    SCHEMA_TEXT,
  );
  return lines.join('\n');
}

/** "Copy fix-it prompt" on Couldn't read: one sentence per fixable issue. */
export function buildFixItPrompt(result: Pick<ParseResult, 'issues'>): string {
  const lead = 'Rewrite your last answer as one fais-moi v1 json block.';
  const parts = [lead];
  for (const issue of result.issues) {
    if (issue.fixIt && !parts.includes(issue.fixIt)) parts.push(issue.fixIt);
  }
  return parts.join(' ');
}
