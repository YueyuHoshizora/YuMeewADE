import type { AiPick, AppState, RoleInput, RoleSlot, Settings } from '../../shared/types.ts';
import { api } from '../api.ts';
import { getLocale, hasMessage, labelValue, LOCALES, localeName, setLocale, t, type Locale } from '../i18n/index.ts';
import { aiPicker } from '../components/picker.ts';
import { button, card, confirmModal, el, field, input, readLocal, row, run, select, setLocked, storeLocal, toast, type View, type ViewContext } from '../components/dom.ts';
import { aiLabel, localTime, sourceLabel } from '../components/display.ts';
import { getTheme, setTheme, type Theme } from '../theme.ts';
import { carePanel } from '../components/care.ts';
import { archiveButton } from '../components/archive.ts';
import { cliGuidance } from '../components/onboarding.ts';
import { mcpPanel } from '../components/mcp-management.ts';
import { editorPreferencesPanel } from '../components/editor-preferences-panel.ts';
import { editorLspPanel } from '../components/editor-lsp-panel.ts';
import { mountProviderCapabilities } from '../components/provider-capabilities.ts';
import { openUsageDetails } from '../components/usage-details.ts';
import { budgetSettingsPanel, usageHistoryPanel } from '../components/usage-history.ts';
type SettingsTab = 'general' | 'ai' | 'roles' | 'usage' | 'editor' | 'mcp' | 'maintenance' | 'log';

export function settingsView(context: ViewContext, redraw: () => void): View {
  const { state } = context; const node = el('div', 'page settings-page'); node.append(el('h1', '', t('nav.settings')));
  const sections: Record<SettingsTab, HTMLElement> = { general: el('div'), ai: el('div'), roles: el('div'), usage: el('div'), editor: el('div'), mcp: el('div'), maintenance: el('div'), log: el('div') };
  const language = select(LOCALES.map(value => ({ value, label: localeName(value) })), getLocale());
  language.onchange = () => { setLocale(language.value as Locale); redraw(); };
  const theme = select(
    (['system', 'light', 'dark'] as const).map(value => ({ value, label: t(`settings.theme.${value}`) })),
    getTheme(),
  );
  theme.onchange = () => setTheme(theme.value as Theme);
  const enter = input(); enter.type = 'checkbox'; enter.checked = readLocal('yumeewade.enterToSend', false); enter.onchange = () => storeLocal('yumeewade.enterToSend', enter.checked);
  const notifications = input(); notifications.type = 'checkbox'; notifications.checked = readLocal('yumeewade.notifications', true);
  notifications.onchange = () => { storeLocal('yumeewade.notifications', notifications.checked); if (notifications.checked && 'Notification' in window && Notification.permission === 'default') void run(async () => { await Notification.requestPermission(); }); };
  const permission = button(t('settings.notificationPermission'), async () => { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); }); permission.disabled = !('Notification' in window) || Notification.permission !== 'default';
  const root = input(state.root); root.spellcheck = false; root.autocomplete = 'off';
  const pickRoot = window.yumeewade?.pickFolder ? [button(t('project.pickFolder'), async () => { const value = await window.yumeewade!.pickFolder(); if (value) root.value = value; })] : [];
  const applyRoot = button(t('settings.rootApply'), async () => {
    const value = root.value.trim();
    if (!value || value === context.state.root) return;
    if (!await confirmModal(t('settings.rootConfirmTitle'), t('settings.rootConfirm', { root: value }), t('settings.rootApply'))) return;
    await api.workspace(value); await context.refresh(); redraw(); toast(t('settings.rootChanged'));
  });
  sections.general.append(card(t('settings.general'), field(t('settings.language'), language), field(t('settings.theme'), theme), field(t('settings.enterToSend'), enter), field(t('settings.notifications'), notifications), permission, field(t('settings.root'), root), row(...pickRoot, applyRoot), el('p', 'muted', t('settings.rootHint'))));
  sections.maintenance.append(carePanel(context), archiveButton(context));
  sections.ai.append(cliGuidance(context));
  sections.usage.append(card(t('usage.details'), button(t('usage.details'), () => openUsageDetails(() => context.state, () => context.state.usage, context.refresh, undefined, false, true))), usageHistoryPanel(), budgetSettingsPanel());
  const mcp = mcpPanel(context); sections.mcp.append(mcp.node);
  sections.editor.append(editorPreferencesPanel(), editorLspPanel(context));
  const initial = aiPicker(state, state.settings.initial);
  const saveInitial = button(t('common.save'), async () => { await api.settings({ initial: initial.value() }); await context.refresh(); toast(t('common.saved')); }, 'primary');
  // With no usable AI the picker is empty; saving would only send an invalid choice.
  setLocked(saveInitial, !initial.value().ai);
  sections.ai.append(card(t('settings.initial'), initial.node, saveInitial));
  const aiSection = card(t('settings.ais'));
  for (const info of state.ais.filter(ai => ai.name !== 'mock')) {
    const access = input(); access.type = 'checkbox'; access.checked = state.settings.fullAccess[info.name] ?? info.fullAccess;
    access.onchange = () => { void run(async () => { access.disabled = true; try { await api.settings({ fullAccess: { ...context.state.settings.fullAccess, [info.name]: access.checked } }); await context.refresh(); } catch (error) { access.checked = !access.checked; throw error; } finally { access.disabled = false; } }); };
    const panel = el('div', 'ai-panel'); const status = el('p', 'muted', `${t(info.available ? 'ai.installed' : 'ai.missing')} · ${info.version || '—'} · ${t('ai.models', { n: info.models.length })}`);
    const source = el('p', 'muted', t('ai.source', { source: sourceLabel(info.source), at: localTime(info.refreshedAt) }));
    panel.append(el('h3', '', aiLabel(info.name)), status, source, row(
      button(t('ai.refresh'), async () => {
        const fresh = await api.refreshAi(info.name);
        status.textContent = `${fresh.version || '—'} · ${t('ai.models', { n: fresh.models.length })}`;
        source.textContent = t('ai.source', { source: sourceLabel(fresh.source), at: localTime(fresh.refreshedAt) });
        await context.refresh(); redraw();
      }),
      button(t('ai.update'), async () => {
        const result = await api.updateAi(info.name);
        toast(t('ai.updated', { before: result.before, after: result.after }));
        await context.refresh(); redraw();
      }),
    ), field(t('ai.fullAccess'), access), el('p', 'warning', t('ai.warning')));
    aiSection.append(panel);
  }
  sections.ai.append(aiSection);
  const modelsSection = card(t('settings.models'));
  const modelPanels: ((state: AppState) => void)[] = [];
  for (const info of state.ais.filter(ai => ai.name !== 'mock')) {
    const panel = el('div', 'model-panel'); panel.append(el('h3', '', aiLabel(info.name))); const list = el('div', 'model-list');
    // Every change starts from the latest state, not a copy taken when the page opened: the save replaces this AI's whole
    // hidden list and order, so a stale copy would undo changes made in another window.
    const current = (settings: Settings) => {
      const hidden = [...(settings.hiddenModels[info.name] ?? [])];
      const oldOrder = settings.modelOrder[info.name] ?? [];
      return { hidden, order: [...oldOrder.filter(id => info.models.some(m => m.id === id)), ...info.models.filter(m => !oldOrder.includes(m.id)).map(m => m.id)] };
    };
    const key = (settings: Settings) => JSON.stringify(current(settings));
    let shown = '';
    async function save(patch: { hidden?: string[]; order?: string[] }): Promise<void> {
      const saved = await api.settings({
        ...(patch.hidden ? { hiddenModels: { ...context.state.settings.hiddenModels, [info.name]: patch.hidden } } : {}),
        ...(patch.order ? { modelOrder: { ...context.state.settings.modelOrder, [info.name]: patch.order } } : {}),
      });
      // Our own change is already on screen; marking it shown keeps the refresh from redrawing away keyboard focus.
      shown = key(saved);
      await context.refresh();
    }
    function render(): void {
      const { hidden, order } = current(context.state.settings); shown = key(context.state.settings);
      list.replaceChildren(...order.map((id, at) => {
        const model = info.models.find(m => m.id === id)!; const check = input(); check.type = 'checkbox'; check.checked = !hidden.includes(id);
        check.onchange = () => { void run(async () => {
          const latest = current(context.state.settings).hidden.filter(v => v !== id);
          try { await save({ hidden: check.checked ? latest : [...latest, id] }); } catch (error) { check.checked = !check.checked; throw error; }
        }); };
        async function move(direction: number): Promise<void> {
          const latest = current(context.state.settings).order; const from = latest.indexOf(id); const to = from + direction;
          if (from < 0 || to < 0 || to >= latest.length) return;
          [latest[from], latest[to]] = [latest[to]!, latest[from]!];
          await save({ order: latest }); render();
          // Keep focus on the moved model; at the top or bottom its same-direction button is disabled, so use the other one.
          const own = (key: 'tree.up' | 'tree.down') => list.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(labelValue(t(key), model.label))}"]`);
          const same = own(direction < 0 ? 'tree.up' : 'tree.down');
          (same && !same.disabled ? same : own(direction < 0 ? 'tree.down' : 'tree.up'))?.focus();
        }
        // The model name tells screen readers which row moves and lets button() return focus to this model's button after the redraw.
        const up = button('↑', () => move(-1)); up.setAttribute('aria-label', labelValue(t('tree.up'), model.label)); up.disabled = at === 0;
        const down = button('↓', () => move(1)); down.setAttribute('aria-label', labelValue(t('tree.down'), model.label)); down.disabled = at === order.length - 1;
        return row(field(model.label, check), el('code', 'muted', model.id), up, down);
      }));
    } render(); panel.append(list); modelsSection.append(panel);
    modelPanels.push(source => { if (key(source.settings) !== shown) render(); });
  }
  sections.ai.append(modelsSection, mountProviderCapabilities());
  const roles = card(t('settings.roles')); const roleList = el('div', 'role-list');
  const drafts: { node: HTMLElement; value: () => RoleInput }[] = [];
  function addRole(role: RoleInput): void {
    // Same bounds as roles.yaml writes on the core (name 60, job 2000).
    const name = input(role.name); name.maxLength = 60; const job = input(role.job); job.maxLength = 2000;
    const main = aiPicker(state, { ai: role.main.cli, model: role.main.model, effort: role.main.effort }, undefined, true);
    const backup = aiPicker(state, { ai: role.backup?.cli ?? '人', model: role.backup?.model ?? '', effort: role.backup?.effort ?? '' }, undefined, true);
    const panel = el('div', 'role-row'); const slot = (pick: AiPick): RoleSlot => ({ cli: pick.ai, model: pick.model, effort: pick.effort });
    const entry = { node: panel, value: (): RoleInput => ({ name: name.value.trim(), job: job.value.trim(), main: slot(main.value()), ...(backup.value().ai !== '人' ? { backup: slot(backup.value()) } : {}) }) };
    panel.append(row(field(t('common.name'), name), field(t('settings.job'), job), button(t('common.remove'), () => { drafts.splice(drafts.indexOf(entry), 1); panel.remove(); }, 'danger')), field(t('settings.main'), main.node), field(t('settings.backup'), backup.node)); drafts.push(entry); roleList.append(panel);
  }
  // The save replaces the whole roles.yaml, so the form must not silently restore a list changed elsewhere (another window,
  // a hand edit of roles.yaml): untouched forms follow the change; edited ones ask before overwriting it.
  const formValue = () => JSON.stringify(drafts.map(d => d.value()));
  let rolesBase = ''; let rolesForm = '';
  function buildRoles(source: AppState): void {
    drafts.length = 0; roleList.replaceChildren();
    for (const [name, role] of Object.entries(source.roles.roles)) addRole({ name, ...role });
    rolesBase = JSON.stringify(source.roles.roles); rolesForm = formValue();
  }
  buildRoles(state);
  roles.append(roleList, row(button(t('settings.addRole'), () => addRole({ name: '', job: '', main: { cli: state.settings.initial.ai, model: state.settings.initial.model, effort: state.settings.initial.effort } })), button(t('common.save'), async () => {
    if (JSON.stringify(context.state.roles.roles) !== rolesBase && !await confirmModal(t('settings.rolesChanged'), t('settings.rolesChangedMessage'), t('settings.rolesOverwrite'))) return;
    await api.roles(drafts.map(d => d.value())); await context.refresh(); buildRoles(context.state); toast(t('common.saved'));
  }, 'primary'))); sections.roles.append(roles);
  const logs = el('div', 'op-log'); let alive = true;
  const actionLabel = (action: string) => {
    const key = `log.${action}`; if (hasMessage(key)) return t(key);
    // Families such as git.stash.<operation> share one label; the operation word stays visible.
    const cut = action.lastIndexOf('.'); const family = `log.${action.slice(0, cut)}`;
    return cut > 0 && hasMessage(family) ? `${t(family)}（${action.slice(cut + 1)}）` : action;
  };
  void run(async () => { const entries = await api.log(); if (!alive) return; for (const entry of entries) { const line = el('div', 'log-entry'); line.append(el('time', 'muted', localTime(entry.at)), el('strong', '', actionLabel(entry.action)), el('span', '', [entry.project, entry.task].filter(Boolean).join(' / '))); logs.append(line); } if (!entries.length) logs.append(el('p', 'muted', t('common.empty'))); }); sections.log.append(card(t('settings.log'), logs));
  const labels: Record<SettingsTab, string> = { general: t('settings.general'), ai: t('settings.tab.ai'), roles: t('settings.roles'), usage: t('settings.tab.usage'), editor: t('settings.tab.editor'), mcp: t('mcp.title'), maintenance: t('settings.tab.maintenance'), log: t('settings.log') };
  const keys = Object.keys(sections) as SettingsTab[];
  const tabList = el('div', 'row settings-tabs'); tabList.setAttribute('role', 'tablist'); tabList.setAttribute('aria-label', t('settings.tabs'));
  const tabs = keys.map(key => {
    const tab = button(labels[key], () => showTab(key)); tab.setAttribute('role', 'tab'); tab.id = `settings-tab-${key}`;
    tab.setAttribute('aria-controls', `settings-panel-${key}`);
    sections[key].id = `settings-panel-${key}`; sections[key].className = 'settings-panel'; sections[key].setAttribute('role', 'tabpanel'); sections[key].setAttribute('aria-labelledby', tab.id);
    return tab;
  });
  // Language changes redraw the whole page; the chosen section survives that and later visits.
  function showTab(key: SettingsTab): void {
    storeLocal('yumeewade.settingsTab', key);
    for (const [index, other] of keys.entries()) {
      const selected = other === key;
      tabs[index]!.setAttribute('aria-selected', String(selected)); tabs[index]!.tabIndex = selected ? 0 : -1; sections[other].hidden = !selected;
    }
  }
  // Roving tabindex: Tab reaches only the selected tab, arrows move between tabs (WAI-ARIA tabs pattern).
  tabList.addEventListener('keydown', event => {
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const last = keys.length - 1;
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault(); showTab(keys[next]!); tabs[next]!.focus();
  });
  tabList.append(...tabs); node.append(tabList, ...keys.map(key => sections[key]));
  const saved = readLocal<string>('yumeewade.settingsTab', 'general');
  showTab(keys.find(key => key === saved) ?? 'general');
  return { node, dispose: () => { alive = false; }, update: state => {
    context.state = state; mcp.update(state); for (const follow of modelPanels) follow(state);
    if (JSON.stringify(state.roles.roles) !== rolesBase && formValue() === rolesForm && !roleList.contains(document.activeElement)) buildRoles(state);
  } };
}
