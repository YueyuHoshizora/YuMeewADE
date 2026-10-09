import type { AiPick, RoleInput, RoleSlot } from '../../shared/types.ts';
import { api } from '../api.ts';
import { getLocale, hasMessage, LOCALES, localeName, setLocale, t, type Locale } from '../i18n/index.ts';
import { aiPicker } from '../components/picker.ts';
import { button, card, el, field, input, readLocal, row, run, select, storeLocal, toast, type View, type ViewContext } from '../components/dom.ts';
import { aiLabel, localTime, sourceLabel } from '../components/display.ts';

export function settingsView(context: ViewContext, redraw: () => void): View {
  const { state } = context; const node = el('div', 'page settings-page'); node.append(el('h1', '', t('nav.settings')));
  const language = select(LOCALES.map(value => ({ value, label: localeName(value) })), getLocale());
  language.onchange = () => { setLocale(language.value as Locale); redraw(); };
  const tools = input(); tools.type = 'checkbox'; tools.checked = readLocal('yumeewade.tools', false); tools.onchange = () => storeLocal('yumeewade.tools', tools.checked);
  node.append(card(t('settings.general'), field(t('settings.language'), language), field(t('settings.tools'), tools), field(t('settings.root'), el('code', '', state.root))));
  const initial = aiPicker(state, state.settings.initial); node.append(card(t('settings.initial'), initial.node, button(t('common.save'), async () => { await api.settings({ initial: initial.value() }); await context.refresh(); toast(t('common.saved')); }, 'primary')));
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
  node.append(aiSection);
  const modelsSection = card(t('settings.models'));
  for (const info of state.ais.filter(ai => ai.name !== 'mock')) {
    const panel = el('div', 'model-panel'); panel.append(el('h3', '', aiLabel(info.name))); const list = el('div', 'model-list');
    let hidden = [...(state.settings.hiddenModels[info.name] ?? [])];
    const oldOrder = state.settings.modelOrder[info.name] ?? [];
    let order = [...oldOrder.filter(id => info.models.some(m => m.id === id)), ...info.models.filter(m => !oldOrder.includes(m.id)).map(m => m.id)];
    async function save(): Promise<void> { await api.settings({ hiddenModels: { ...context.state.settings.hiddenModels, [info.name]: hidden }, modelOrder: { ...context.state.settings.modelOrder, [info.name]: order } }); await context.refresh(); }
    function render(): void {
      list.replaceChildren(...order.map((id, at) => {
        const model = info.models.find(m => m.id === id)!; const check = input(); check.type = 'checkbox'; check.checked = !hidden.includes(id);
        check.onchange = () => { void run(async () => { const before = [...hidden]; if (check.checked) hidden = hidden.filter(v => v !== id); else hidden.push(id); try { await save(); } catch (error) { hidden = before; check.checked = !check.checked; throw error; } }); };
        async function move(direction: number): Promise<void> { const to = at + direction; if (to < 0 || to >= order.length) return; const before = [...order]; [order[at], order[to]] = [order[to]!, order[at]!]; try { await save(); render(); } catch (error) { order = before; throw error; } }
        const up = button('↑', () => move(-1)); up.setAttribute('aria-label', t('tree.up')); up.disabled = at === 0;
        const down = button('↓', () => move(1)); down.setAttribute('aria-label', t('tree.down')); down.disabled = at === order.length - 1;
        return row(field(model.label, check), el('code', 'muted', model.id), up, down);
      }));
    } render(); panel.append(list); modelsSection.append(panel);
  }
  node.append(modelsSection);
  const roles = card(t('settings.roles')); const roleList = el('div', 'role-list');
  const drafts: { node: HTMLElement; value: () => RoleInput }[] = [];
  function addRole(role: RoleInput): void {
    const name = input(role.name); const job = input(role.job);
    const main = aiPicker(state, { ai: role.main.cli, model: role.main.model, effort: role.main.effort }, undefined, true);
    const backup = aiPicker(state, { ai: role.backup?.cli ?? '人', model: role.backup?.model ?? '', effort: role.backup?.effort ?? '' }, undefined, true);
    const panel = el('div', 'role-row'); const slot = (pick: AiPick): RoleSlot => ({ cli: pick.ai, model: pick.model, effort: pick.effort });
    const entry = { node: panel, value: (): RoleInput => ({ name: name.value.trim(), job: job.value.trim(), main: slot(main.value()), ...(backup.value().ai !== '人' ? { backup: slot(backup.value()) } : {}) }) };
    panel.append(row(field(t('common.name'), name), field(t('settings.job'), job), button(t('common.remove'), () => { drafts.splice(drafts.indexOf(entry), 1); panel.remove(); }, 'danger')), field(t('settings.main'), main.node), field(t('settings.backup'), backup.node)); drafts.push(entry); roleList.append(panel);
  }
  for (const [name, role] of Object.entries(state.roles.roles)) addRole({ name, ...role });
  roles.append(roleList, row(button(t('settings.addRole'), () => addRole({ name: '', job: '', main: { cli: state.settings.initial.ai, model: state.settings.initial.model, effort: state.settings.initial.effort } })), button(t('common.save'), async () => { await api.roles(drafts.map(d => d.value())); await context.refresh(); toast(t('common.saved')); }, 'primary'))); node.append(roles);
  const logs = el('div', 'op-log'); let alive = true;
  const actionLabel = (action: string) => { const key = `log.${action}`; return hasMessage(key) ? t(key) : action; };
  void run(async () => { const entries = await api.log(); if (!alive) return; for (const entry of entries) { const line = el('div', 'log-entry'); line.append(el('time', 'muted', localTime(entry.at)), el('strong', '', actionLabel(entry.action)), el('span', '', [entry.project, entry.task].filter(Boolean).join(' / '))); logs.append(line); } if (!entries.length) logs.append(el('p', 'muted', t('common.empty'))); }); node.append(card(t('settings.log'), logs));
  return { node, dispose: () => { alive = false; }, update: state => { context.state = state; } };
}
