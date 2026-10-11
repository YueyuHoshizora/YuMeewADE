import type { AiUsage, AppState, Settings, UsageState } from '../../shared/types.ts';
import { api, request } from '../api.ts';
import { getLocale, t } from '../i18n/index.ts';
import { aiLabel, cloudCreditsLabel, extraUsageLabel, localDateTime, localTime, prepaidLabel, quotaLabel } from './display.ts';
import { button, confirmModal, el, field, input, row, run } from './dom.ts';

function accountUsage(usage: AiUsage | undefined): HTMLElement {
  const node = el('div', 'account-quota');
  node.append(el('p', '', t(usage?.status === 'ready' ? 'usage.ready' : 'usage.unavailable')));
  if (!usage?.quotaAt) { node.append(el('p', 'muted', t('usage.noData'))); return node; }
  node.append(el('p', 'muted', t('usage.quotaAt', { at: localTime(usage.quotaAt) })));
  for (const window of usage.windows) {
    if (usage.ai === 'grok' && window.label === 'on-demand') continue;
    const expired = !!window.resetsAt && Date.parse(window.resetsAt) <= Date.now();
    const label = quotaLabel(window.label);
    const text = expired ? `${t('usage.windowNoReset', { label, percent: `${Math.round(window.usedPercent)}%` })} · ${t('usage.windowReset', { label, reset: localTime(window.resetsAt!) })}`
      : window.resetsAt ? t('usage.window', { label, percent: `${Math.round(window.usedPercent)}%`, reset: localTime(window.resetsAt) })
        : t('usage.windowNoReset', { label, percent: `${Math.round(window.usedPercent)}%` });
    node.append(el('p', expired ? 'muted' : '', expired ? text : `${text} · ${t('usage.remaining', { percent: Math.max(0, Math.round(100 - window.usedPercent)) })}`));
  }
  if (usage.ai !== 'grok' && usage.prepaidCents !== undefined) node.append(el('p', '', prepaidLabel(usage.prepaidCents)));
  if (usage.extraUsage) node.append(el('p', '', extraUsageLabel(usage.extraUsage)));
  if (usage.cloudCredits) node.append(el('p', '', cloudCreditsLabel(usage.cloudCredits)));
  if (usage.resetCredits) {
    const credits = el('details', 'disclosure reset-credits');
    credits.append(el('summary', '', t('usage.resetCredits', { count: usage.resetCredits.availableCount })));
    for (const credit of usage.resetCredits.credits) {
      const title = credit.title ?? t('usage.resetCreditDefault');
      credits.append(el('p', 'muted', credit.expiresAt ? t('usage.resetCreditExpires', { title, expires: localTime(credit.expiresAt) }) : t('usage.resetCreditNoExpiry', { title })));
    }
    node.append(credits);
  }
  if (usage.limited) node.append(el('p', 'usage-limited', t('usage.limited')));
  return node;
}

/** Read live UI state only; quota queries remain owned by the core scheduler. */
export function openUsageDetails(getState: () => AppState, getUsage: () => UsageState, refresh: () => Promise<void>, selectedAi?: string): void {
  const dialog = el('dialog', 'modal usage-details');
  const title = el('h2', '', t('usage.details')); title.id = 'usage-details-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const accounts = el('div', 'usage-accounts');
  const add = el('details', 'disclosure'); add.append(el('summary', '', t('usage.addAccount')));
  const provider = el('select');
  for (const ai of ['claude', 'codex', 'grok', 'gemini']) { const option = el('option', '', aiLabel(ai)); option.value = ai; provider.append(option); }
  provider.value = selectedAi === 'codex' || selectedAi === 'grok' || selectedAi === 'gemini' ? selectedAi : 'claude';
  const name = input(); name.required = true; name.autocomplete = 'off';
  // Gemini's CLI only logs in inside a real terminal, so the user runs the shown command and then imports.
  let prepared: { configDir: string } | null = null;
  const geminiSteps = el('p', 'muted', t('usage.geminiSteps'));
  const commandLine = input(); commandLine.readOnly = true; commandLine.spellcheck = false; commandLine.onfocus = () => commandLine.select();
  const commandField = field(t('usage.terminalCommand'), commandLine);
  const form = el('form', 'form');
  const submit = el('button', 'primary', t('usage.addAccount')); submit.type = 'submit';
  const sync = (): void => {
    const manual = provider.value === 'gemini';
    geminiSteps.hidden = !manual; commandField.hidden = !prepared;
    submit.textContent = manual ? t(prepared ? 'usage.importLogin' : 'usage.prepareLogin') : t('usage.addAccount');
  };
  provider.onchange = () => { prepared = null; sync(); };
  form.append(field(t('usage.provider'), provider), field(t('common.name'), name), geminiSteps, commandField, submit);
  sync();
  form.onsubmit = event => { event.preventDefault(); void run(async () => {
    submit.disabled = true;
    const manual = provider.value === 'gemini';
    if (!manual) submit.textContent = t('usage.loggingIn');
    try {
      if (manual && !prepared) {
        const next = await request<{ configDir: string; command: string }>('/api/accounts/prepare', { ai: provider.value });
        prepared = { configDir: next.configDir };
        commandLine.value = `HOME='${next.configDir.replaceAll("'", "'\\''")}' ${next.command}`;
        return;
      }
      await request<Settings>('/api/accounts/add', manual ? { ai: provider.value, name: name.value.trim(), configDir: prepared!.configDir } : { ai: provider.value, name: name.value.trim(), login: true });
      await refresh(); name.value = ''; prepared = null; add.open = false; render();
    } finally { submit.disabled = false; sync(); }
  }); };
  add.append(el('p', 'muted', t('usage.accountHelp')), form);
  const reload = button(t('usage.refresh'), async () => { await request<UsageState>('/api/accounts/refresh', {}); await refresh(); render(); });
  dialog.append(row(title, button(t('common.close'), () => dialog.close())), el('p', 'muted', t('usage.accountNotice')), reload, accounts, add);
  let previous = '';
  function render(): void {
    const state = getState(); const usage = getUsage();
    const expired = usage.ais.map(entry => entry.windows.map(window => !!window.resetsAt && Date.parse(window.resetsAt) <= Date.now()));
    const snapshot = JSON.stringify([state.settings.accounts, state.settings.activeAccounts, usage.ais, usage.codexReset, getLocale(), expired]);
    if (snapshot === previous) return; previous = snapshot;
    // Preserve keyboard focus when a quota update replaces the account cards.
    const focused = accounts.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['accountAction'] : undefined;
    const sections = ['claude', 'codex', 'grok', 'gemini'].map(ai => {
      const section = el('section', 'usage-provider'); const title = el('h3', '', aiLabel(ai)); if (ai === 'codex' && usage.codexReset) title.append(el('span', 'usage-reset', t('usage.codexReset', { at: localDateTime(usage.codexReset) }))); section.append(title);
      const profiles = state.settings.accounts[ai] ?? [];
      for (const profile of profiles) {
        const card = el('section', 'account-card'); const active = (state.settings.activeAccounts[ai] ?? 'default') === profile.id;
        const heading = row(el('h4', '', profile.name));
        if (active) heading.append(el('span', 'account-active', t('usage.active')));
        else { const activate = button(t('usage.activate'), async () => { await api.settings({ activeAccounts: { [ai]: profile.id } }); await refresh(); render(); }); activate.dataset['accountAction'] = `${ai}:${profile.id}:activate`; heading.append(activate); }
        if (profile.id !== 'default') { const remove = button(t('usage.remove'), async () => {
          if (!await confirmModal(t('usage.remove'), t('usage.removeConfirm', { name: profile.name }), t('usage.remove'))) return;
          await request<Settings>('/api/accounts/remove', { ai, id: profile.id }); await refresh(); render();
        }); remove.dataset['accountAction'] = `${ai}:${profile.id}:remove`; heading.append(remove); }
        card.append(heading, accountUsage(usage.ais.find(entry => entry.ai === ai && entry.account === profile.id))); section.append(card);
      }
      return section;
    });
    accounts.replaceChildren(...sections);
    if (focused) { const target = Array.from(accounts.querySelectorAll<HTMLElement>('[data-account-action]')).find(node => node.dataset['accountAction'] === focused); (target ?? reload).focus(); }
  }
  render(); document.body.append(dialog); dialog.showModal();
  const timer = window.setInterval(render, 500);
  dialog.addEventListener('close', () => { window.clearInterval(timer); dialog.remove(); }, { once: true });
}
