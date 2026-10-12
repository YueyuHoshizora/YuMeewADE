import type { VerifyResult, VerifyStatus } from '../../shared/types.ts';
import { t } from '../i18n/index.ts';
import { parseDiff } from './diff.ts';
import { disclosure, el } from './dom.ts';
import { localDateTime } from './display.ts';

export function verificationSteps(result: Pick<VerifyResult, 'steps'>): HTMLElement[] {
  return (result.steps ?? []).map(step => disclosure(
    `${step.name} · ${t(step.ok ? 'verify.pass' : 'verify.fail')}`,
    el('code', '', step.command),
    el('p', '', t('verify.result', { code: step.exitCode ?? t('common.none'), seconds: (step.ms / 1000).toFixed(1) })),
    ...(step.timedOut ? [el('p', 'warning', t('verify.timedOut'))] : []),
    ...(step.truncated ? [el('p', 'warning', t('verify.truncated'))] : []),
    el('pre', 'verify-output', step.output),
  ));
}

/** Latest still-valid verification summary (`GET /api/task/verify`); null means none applies to the current content. */
export function verificationStatusView(status: VerifyStatus | null): HTMLElement[] {
  if (!status) return [el('p', 'muted', t('verify.none'))];
  const passed = status.ok && !status.drifted;
  return [
    el('strong', passed ? 'verify-pass' : 'error-mark', t(passed ? 'verify.pass' : 'verify.fail')),
    el('p', 'muted', `${t('verify.latest')} · ${localDateTime(status.at)}`),
    ...(status.timedOut ? [el('p', 'warning', t('verify.timedOut'))] : []),
    ...(status.drifted ? [el('p', 'warning', t('verification.hint'))] : []),
    ...verificationSteps(status),
  ];
}

/** Read-only unified diff grouped by file, using the same markup as the task diff viewer. */
export function readonlyDiffView(diff: { diff: string; truncated: boolean }): HTMLElement {
  const viewer = el('div', 'diff-viewer');
  if (diff.truncated) viewer.append(el('p', 'warning diff-warning', t('copy.truncated')));
  const files = parseDiff(diff.diff);
  if (!files.length) viewer.append(el('p', 'muted', t('copy.noChanges')));
  for (const [index, file] of files.entries()) {
    const section = disclosure('');
    section.className = 'diff-file';
    section.open = index < 3;
    section.querySelector('summary')!.append(el('span', 'diff-path', file.path || t('copy.diff')), el('span', 'diff-added', `+${file.added}`), el('span', 'diff-removed', `−${file.removed}`));
    const content = el('pre', 'diff-lines');
    for (const line of file.lines) content.append(el('span', `diff-line diff-${line.kind}`, line.text));
    section.append(content); viewer.append(section);
  }
  return viewer;
}
