import type { ProjectTrustState, ProjectTrustView } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, confirmModal, el, field, iconButton, row, select } from './dom.ts';

export function projectTrustButton(project: string, task?: string): HTMLButtonElement {
  return button(t('trust.title'), async () => {
    let current = await request<ProjectTrustView>(query('/api/project/trust', { project, ...(task ? { task } : {}) }));
    const dialog = el('dialog', 'modal'); dialog.setAttribute('aria-label', t('trust.title'));
    const state = select(['unreviewed', 'trusted', 'restricted'].map(value => ({ value, label: t(`trust.${value as ProjectTrustState}`) })), current.state);
    const overview = el('div'); const overrides = el('div', 'form-grid');
    const choices = new Map<string, HTMLSelectElement>();
    for (const ai of Object.keys(current.fullAccess)) {
      const choice = select([{ value: '', label: t('trust.inherit') }, { value: 'false', label: t('trust.safe') }, { value: 'true', label: t('trust.full') }], current.overrides[ai] === undefined ? '' : String(current.overrides[ai]));
      choices.set(ai, choice); overrides.append(field(ai, choice));
    }
    function render(): void {
      overview.replaceChildren(el('p', '', t('trust.user', { user: current.user })), el('p', '', t('trust.root', { root: current.root })), el('p', '', t('trust.cwd', { cwd: current.cwd })), el('p', '', t('trust.additional', { dirs: current.additionalDirectories.join(', ') })));
      overview.append(...Object.entries(current.fullAccess).map(([ai, full]) => el('p', '', `${ai}: ${t(full ? 'trust.full' : 'trust.safe')}`)));
      if (current.rootChanged) overview.append(el('p', 'warning', t('trust.changed')));
      for (const choice of choices.values()) choice.disabled = state.value !== 'trusted';
    }
    state.onchange = render;
    dialog.append(row(el('h2', '', t('trust.title')), iconButton('×', t('common.close'), () => dialog.close())), overview, el('p', 'warning', t('trust.warning')), field(t('trust.title'), state), overrides, button(t('common.save'), async () => {
      if (!await confirmModal(t('trust.title'), t('trust.confirm'), t('common.save'))) return;
      const values: Record<string, boolean> = {};
      for (const [ai, choice] of choices) if (choice.value) values[ai] = choice.value === 'true';
      current = await request<ProjectTrustView>('/api/project/trust', { project, state: state.value, overrides: values, revision: current.revision, confirmed: true });
      render();
    }));
    const close = dialog.querySelector('button'); close?.setAttribute('aria-label', t('common.close'));
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal(); render();
  });
}
