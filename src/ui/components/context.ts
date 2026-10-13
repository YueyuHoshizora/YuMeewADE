import type { TaskContext, ContextPreview, ContextManifest, PinnedSource } from '../../shared/types.ts';
import { request, query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, button, area, modal, UserError, input, field, row, disclosure, setLocked, errorMessage } from './dom.ts';
import { localDateTime } from './display.ts';

export function contextButton(project: string, task: string, pick: () => { ai: string; model?: string }): HTMLButtonElement {
  return button(t('context.title'), async () => {
    let value = await request<TaskContext>(query('/api/task/context', { project, task }));
    const node = el('form', 'context-editor');
    node.onsubmit = event => event.preventDefault();
    const controls = el('fieldset', 'context-controls');
    const decisions = area(value.decisions, t('context.decisions')); decisions.maxLength = 2_000_000;
    const number = (name: string, initial: number | undefined, min = 0, max = 2_000_000): HTMLInputElement => {
      const control = input(initial === undefined ? '' : String(initial));
      control.type = 'number'; control.min = String(min); control.max = String(max); control.step = '1'; control.name = name;
      return control;
    };
    const decisionBudget = number('decisionBudget', value.decisionBudget);
    const sources = el('div', 'context-sources');
    const result = el('div', 'context-preview'); result.setAttribute('aria-live', 'polite');
    const failure = el('p', 'warning'); failure.setAttribute('role', 'alert'); failure.hidden = true;
    const suggestions = el('datalist'); suggestions.id = `context-files-${crypto.randomUUID()}`;
    const sourceRows: { node: HTMLElement; read: () => PinnedSource }[] = [];
    let busy = false;
    const addSource = (source: PinnedSource): void => {
      if (busy) return;
      if (sourceRows.length >= 30) throw new UserError(t('context.sourceLimit'));
      const entry = el('section', 'context-source');
      const path = input(source.path); path.name = 'path'; path.required = true; path.maxLength = 4096; path.setAttribute('list', suggestions.id);
      const start = number('start', source.start, 1, Number.MAX_SAFE_INTEGER); start.required = true;
      const end = number('end', source.end, 1, Number.MAX_SAFE_INTEGER); end.required = true;
      const enabled = input(); enabled.type = 'checkbox'; enabled.name = 'enabled'; enabled.checked = source.enabled !== false;
      const priority = number('priority', source.priority), order = number('order', source.order), allocatedChars = number('allocatedChars', source.allocatedChars);
      const read = (): PinnedSource => {
        if (!path.value.trim() || !Number.isSafeInteger(start.valueAsNumber) || !Number.isSafeInteger(end.valueAsNumber)
          || end.valueAsNumber < start.valueAsNumber || end.valueAsNumber - start.valueAsNumber > 10_000) {
          throw new UserError(t('context.invalidSource'));
        }
        return { path: path.value, start: start.valueAsNumber, end: end.valueAsNumber, enabled: enabled.checked,
          ...(priority.value === '' ? {} : { priority: priority.valueAsNumber }),
          ...(order.value === '' ? {} : { order: order.valueAsNumber }),
          ...(allocatedChars.value === '' ? {} : { allocatedChars: allocatedChars.valueAsNumber }) };
      };
      const remove = button(t('context.removeSource'), () => {
        if (busy) return;
        sourceRows.splice(sourceRows.findIndex(item => item.node === entry), 1); entry.remove();
      }, 'subtle'); remove.dataset.action = 'remove-source';
      entry.append(field(t('context.path'), path), row(field(t('context.start'), start), field(t('context.end'), end), field(t('context.enabled'), enabled), remove),
        disclosure(t('context.advanced'), field(t('context.priority'), priority), field(t('context.order'), order), field(t('context.allocatedChars'), allocatedChars)));
      sourceRows.push({ node: entry, read }); sources.append(entry);
    };
    value.sources.forEach(addSource);
    const add = button(t('context.addSource'), () => { addSource({ path: '', start: 1, end: 1 }); sourceRows.at(-1)?.node.querySelector('input')?.focus(); });
    add.dataset.action = 'add-source';
    const filter = input('', t('context.findFiles')); filter.maxLength = 200; filter.name = 'fileQuery';
    const choices = el('div', 'context-file-choices');
    const suggestionError = el('p', 'warning'); suggestionError.hidden = true;
    let suggestionSerial = 0;
    async function findFiles(): Promise<void> {
      const serial = ++suggestionSerial;
      const found = await Promise.allSettled([
        request<{ files: string[]; total: number }>(query('/api/task/files', { project, task, q: filter.value })),
        request<{ files: string[]; total: number }>(query('/api/task/files', { project, q: filter.value })),
      ]);
      if (serial !== suggestionSerial || !node.isConnected) return;
      const paths = new Set(value.sources.map(source => source.path));
      const errors: string[] = [];
      for (const response of found) {
        if (response.status === 'fulfilled') response.value.files.forEach(path => paths.add(path));
        else errors.push(errorMessage(response.reason));
      }
      suggestionError.textContent = errors.join('\n'); suggestionError.hidden = !errors.length;
      suggestions.replaceChildren(...[...paths].map(path => { const option = el('option'); option.value = path; return option; }));
      choices.replaceChildren(...[...paths].map(path => {
        const choice = button(path, () => addSource({ path, start: 1, end: 1 }), 'subtle'); choice.dataset.action = 'choose-source';
        return choice;
      }));
      if (!paths.size && !errors.length) choices.append(el('p', 'muted', t('common.empty')));
    }
    const search = button(t('context.findFiles'), findFiles); search.dataset.action = 'find-files';
    const picker = disclosure(t('context.findFiles'), row(filter, search), suggestionError, choices);
    let timer: number | undefined;
    filter.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void findFiles(); }, 250); };
    async function save(preview: boolean): Promise<void> {
      if (busy) return;
      const invalid = node.querySelector<HTMLInputElement>('input:invalid, textarea:invalid');
      if (invalid) {
        let ancestor = invalid.parentElement;
        while (ancestor && ancestor !== node) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
          ancestor = ancestor.parentElement;
        }
      }
      if (!node.reportValidity()) throw new UserError(t('context.invalidFields'));
      const draft: TaskContext = { decisions: decisions.value, sources: sourceRows.map(source => source.read()),
        ...(decisionBudget.value === '' ? {} : { decisionBudget: decisionBudget.valueAsNumber }),
        ...(value.revision === undefined ? {} : { revision: value.revision }) };
      const choice = preview ? pick() : undefined;
      busy = true; controls.disabled = true; setLocked(saveButton, true); setLocked(previewButton, true);
      failure.hidden = true; result.replaceChildren();
      try {
        // Advance CAS only after a successful save; never replace the editable draft on failure.
        value = await request<TaskContext>('/api/task/context', { project, task, context: draft });
        result.append(el('p', 'muted', t('context.saved')));
        if (!choice) return;
        const handoff = await request<ContextPreview>(query('/api/task/handoff', { project, task, ai: choice.ai, model: choice.model ?? '' }));
        result.append(el('p', '', t('context.history', { start: handoff.handoff.start ?? '—', end: handoff.handoff.end ?? '—' })));
        if (handoff.handoff.truncated || handoff.context.truncated) result.append(el('p', 'warning', t('context.truncated')));
        result.append(el('pre', '', handoff.context.text), el('pre', '', handoff.handoff.text));
        for (const allocation of handoff.context.allocations) result.append(el('p', '', `${allocation.id} · ${t(`context.status.${allocation.status}`)} · ${allocation.sentChars}/${allocation.allocatedChars} ${t('context.characters')}`));
      } catch (error) {
        failure.textContent = `${errorMessage(error)} · ${t('context.draftRetained')}`; failure.hidden = false;
        throw error;
      } finally {
        busy = false; controls.disabled = false; setLocked(saveButton, false); setLocked(previewButton, false);
      }
    }
    const saveButton = button(t('context.save'), () => save(false)); saveButton.dataset.action = 'save-context';
    const previewButton = button(t('context.preview'), () => save(true)); previewButton.dataset.action = 'preview-context';
    controls.append(field(t('context.decisions'), decisions), el('h3', '', t('context.sources')), sources, add, picker,
      disclosure(t('context.advanced'), field(t('context.decisionBudget'), decisionBudget)));
    node.append(controls, suggestions, row(saveButton, previewButton), failure, result);
    modal(t('context.title'), node);
    void findFiles();
  }, 'subtle');
}

/** Attach to a stored turn, using its actual request ID rather than rebuilding current sources. */
export function contextManifestButton(project: string, task: string, requestId: string): HTMLButtonElement {
  return button(t('context.preview'), async () => {
    const manifest = await request<ContextManifest | null>(query('/api/task/context/manifest', { project, task, request: requestId }));
    const node = el('div');
    if (!manifest) node.append(el('p', '', t('context.status.unavailable')));
    else {
      node.append(el('p', '', `${manifest.request} · ${manifest.ai} · ${localDateTime(manifest.at)}`), el('pre', '', manifest.context.text), el('pre', '', manifest.handoff.text));
      for (const allocation of manifest.context.allocations) node.append(el('p', '', `${allocation.id} · ${t(`context.status.${allocation.status}`)} · ${allocation.sentChars}/${allocation.allocatedChars} ${t('context.characters')}`));
      node.append(el('pre', '', JSON.stringify({ allocations: manifest.context.allocations, providerTokens: manifest.providerTokens }, null, 2)));
    }
    modal(t('context.title'), node);
  }, 'subtle');
}
