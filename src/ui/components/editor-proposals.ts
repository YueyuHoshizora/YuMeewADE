import type { EditorProposal, ProposalDecision, ProviderCapability } from '../../shared/types.ts';
import type { WorkbenchPanelContext } from './files.ts';
import { request, query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, button, area, confirmModal } from './dom.ts';
export function mountEditorProposals(context: WorkbenchPanelContext): HTMLElement {
  const { project, task, editor } = context;
  const node = el('section'); const instruction = area('', t('proposal.instruction'));
  const provider = el('select'); const model = el('input'); model.placeholder = t('proposal.model');
  const effort = el('input'); effort.placeholder = t('proposal.effort');
  const results = el('div'); const status = el('p'); status.setAttribute('role', 'status');
  let busy = false;
  const render = (proposal: EditorProposal) => {
    const section = el('section'); section.append(el('h4', '', `${proposal.path} · ${proposal.ai}`));
    const base = el('details'); base.append(el('summary', '', t('proposal.base')), el('pre', '', proposal.base));
    const local = el('details'); local.append(el('summary', '', t('proposal.local')), el('pre', '', proposal.local));
    section.append(base, local);
    if (proposal.edits.some(edit => edit.state === 'accepted')) section.append(button(t('proposal.restore'), async () => {
      if (busy) return;
      const snapshot = editor.snapshot();
      if (!snapshot || snapshot.path !== proposal.path || snapshot.revision !== proposal.revision) { status.textContent = t('proposal.conflict'); return; }
      if (!await confirmModal(t('proposal.restore'), t('proposal.restoreConfirm'), t('proposal.restore'))) return;
      if (!editor.applyEdits(snapshot, [{ from: 0, to: snapshot.text.length, text: proposal.current }])) { status.textContent = t('proposal.conflict'); return; }
      status.textContent = t('proposal.note');
    }, 'subtle'));
    for (const edit of proposal.edits) {
      const hunk = el('section');
      hunk.append(button(`${edit.from}–${edit.to}`, () => { void context.open(proposal.path, proposal.local.slice(0, edit.from).split('\n').length); }, 'subtle'), el('p', '', t('proposal.local')), el('pre', '', proposal.local.slice(edit.from, edit.to)), el('p', '', t('proposal.ai')), el('pre', '', edit.text));
      const decide = async (accept: boolean) => {
        if (busy) return; busy = true;
        let release: (() => void) | null = null;
        let remoteStarted = false;
        try {
          const snapshot = editor.snapshot();
          if (!snapshot || snapshot.path !== proposal.path || snapshot.revision !== proposal.revision || snapshot.text !== proposal.current) throw new Error(t('proposal.conflict'));
          release = editor.reserve(snapshot);
          if (!release) throw new Error(t('proposal.conflict'));
          remoteStarted = true;
          const result = await request<ProposalDecision>('/api/editor/proposals/decide', { project, task, id: proposal.id, version: proposal.version, edit: edit.id, accept, text: snapshot.text });
          Object.assign(proposal, result.proposal);
          if (accept && !editor.applyEdits(result.expected, result.edits)) throw new Error(t('proposal.conflict'));
          section.replaceWith(render(proposal));
          node.dispatchEvent(new CustomEvent('yumeewade:proposal-decision', { bubbles: true, detail: { project, task, path: proposal.path, from: edit.from, to: edit.to, accept, edits: proposal.edits } }));
          status.textContent = t('proposal.note');
        } catch {
          if (remoteStarted) {
            const latest = await request<{ proposals: EditorProposal[] }>(query('/api/editor/proposals', { project, task })).catch(() => null);
            const saved = latest?.proposals.find(value => value.id === proposal.id);
            if (saved) Object.assign(proposal, saved);
          }
          section.replaceWith(render(proposal)); status.textContent = t('proposal.conflict');
        } finally { release?.(); busy = false; }
      };
      if (edit.state === 'pending') hunk.append(button(t('proposal.accept'), () => decide(true)), button(t('proposal.reject'), () => decide(false), 'subtle'));
      else hunk.append(el('p', '', t(`proposal.${edit.state}`)));
      section.append(hunk);
    }
    return section;
  };
  const generate = button(t('proposal.generate'), async () => {
    if (busy) return; const snapshot = editor.snapshot(); if (!snapshot) { status.textContent = t('proposal.conflict'); return; }
    busy = true; generate.disabled = true;
    try {
      const selection = snapshot.selection.from === snapshot.selection.to ? { from: 0, to: snapshot.text.length } : snapshot.selection;
      const proposal = await request<EditorProposal>('/api/editor/proposals/generate', { project, task, path: snapshot.path, revision: snapshot.revision, text: snapshot.text, selection, instruction: instruction.value, ai: provider.value, ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(effort.value.trim() ? { effort: effort.value.trim() } : {}) });
      results.prepend(render(proposal)); status.textContent = t('proposal.note');
      node.dispatchEvent(new CustomEvent('yumeewade:proposal-generated', { bubbles: true, detail: { project, task, path: proposal.path, edits: proposal.edits } }));
    } catch { status.textContent = t('proposal.conflict'); }
    finally { busy = false; generate.disabled = !provider.options.length; }
  });
  generate.disabled = true;
  node.append(el('h3', '', t('proposal.title')), el('p', '', t('proposal.note')), provider, model, effort, instruction, generate, button(t('proposal.stop'), async () => { await request('/api/editor/proposals/stop', { project, task }); }, 'subtle'), status, results);
  void request<{ providers: ProviderCapability[] }>('/api/ai/capabilities').then(({ providers }) => {
    for (const capability of providers.filter(p => p.readonly && p.ai !== 'mock')) { const option = el('option'); option.value = capability.ai; option.textContent = `${capability.ai} · ${capability.enforcement}`; provider.append(option); }
    generate.disabled = !provider.options.length;
    if (!provider.options.length) status.textContent = t('cap.no');
  }).catch(() => { status.textContent = t('cap.no'); });
  void request<{ proposals: EditorProposal[] }>(query('/api/editor/proposals', { project, task })).then(({ proposals }) => {
    for (const proposal of proposals.reverse()) {
      results.append(render(proposal));
      node.dispatchEvent(new CustomEvent('yumeewade:proposal-generated', { bubbles: true, detail: { project, task, path: proposal.path, edits: proposal.edits } }));
    }
  }).catch(() => { status.textContent = t('proposal.conflict'); });
  return node;
}
