import type { EditorProposal, ProposalDecision, ProposalFile } from '../../shared/editor-proposals.ts';
import type { ProviderCapability } from '../../shared/types.ts';
import type { WorkbenchPanelContext } from './files.ts';
import { api, request, query } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, button, area, confirmModal, errorMessage, input, setLocked, UserError } from './dom.ts';
import { confirmUsageRound } from './usage-history.ts';
export function mountEditorProposals(context: WorkbenchPanelContext): HTMLElement {
  const { project, task, editor } = context;
  const node = el('section'); const instruction = area('', t('proposal.instruction'));
  const provider = el('select'); provider.setAttribute('aria-label', t('ai.label')); const model = input('', t('proposal.model'));
  const effort = input('', t('proposal.effort'));
  const files = el('fieldset'); const results = el('div'); const status = el('p'); status.setAttribute('role', 'status');
  const selected = new Set<string>(); let busy = false;
  const refreshFiles = () => {
    const snapshots = editor.snapshots();
    files.replaceChildren(el('legend', '', t('proposalMulti.files')));
    if (!selected.size) { const active = editor.snapshot(); if (active) selected.add(active.path); }
    for (const snapshot of snapshots) {
      const label = el('label'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(snapshot.path);
      checkbox.onchange = () => { if (checkbox.checked) selected.add(snapshot.path); else selected.delete(snapshot.path); };
      label.append(checkbox, document.createTextNode(snapshot.path)); files.append(label);
    }
  };
  const announce = (proposal: EditorProposal) => {
    for (const file of proposal.files) node.dispatchEvent(new CustomEvent('yumeewade:proposal-generated', { bubbles: true, detail: { project, task, path: file.path, edits: file.edits } }));
  };
  const render = (proposal: EditorProposal) => {
    const section = el('section'); section.append(el('h4', '', proposal.ai));
    const decide = async (accept: boolean, target?: { path: string; edit: string }) => {
      if (busy) return; busy = true;
      let release: (() => void) | null = null; let remoteStarted = false;
      try {
        const affected = target ? proposal.files.filter(file => file.path === target.path) : proposal.files.filter(file => file.edits.some(edit => edit.state === 'pending'));
        const snapshots = editor.snapshots();
        const expected = affected.map(file => {
          const snapshot = snapshots.find(snapshot => snapshot.path === file.path);
          if (!snapshot || snapshot.revision !== file.revision || snapshot.text !== file.current) throw new UserError(t('proposal.conflict'));
          return { path: snapshot.path, revision: snapshot.revision, text: snapshot.text };
        });
        release = editor.reserveAll(expected); if (!release) throw new UserError(t('proposal.conflict'));
        remoteStarted = true;
        const result = await request<ProposalDecision>('/api/editor/proposals/decide', { project, task, id: proposal.id, version: proposal.version, accept, snapshots: expected, ...(target ? { target } : {}) });
        Object.assign(proposal, result.proposal);
        if (accept && !editor.applyEditsAll(result.changes)) throw new UserError(t('proposal.conflict'));
        section.replaceWith(render(proposal)); announce(proposal); status.textContent = t('proposal.note');
      } catch (error) {
        if (remoteStarted) {
          const latest = await request<{ proposals: EditorProposal[] }>(query('/api/editor/proposals', { project, task })).catch(() => null);
          const saved = latest?.proposals.find(value => value.id === proposal.id); if (saved) Object.assign(proposal, saved);
        }
        section.replaceWith(render(proposal)); status.textContent = errorMessage(error);
      } finally { release?.(); busy = false; }
    };
    if (proposal.files.some(file => file.edits.some(edit => edit.state === 'pending'))) section.append(button(t('proposalMulti.acceptAll'), () => decide(true)), button(t('proposalMulti.rejectAll'), () => decide(false), 'subtle'));
    if (proposal.files.some(file => file.edits.some(edit => edit.state === 'accepted'))) section.append(button(t('proposal.restore'), async () => {
      if (busy) return;
      const snapshots = editor.snapshots(); const changes = [];
      for (const file of proposal.files.filter(file => file.edits.some(edit => edit.state === 'accepted'))) {
        const snapshot = snapshots.find(snapshot => snapshot.path === file.path);
        // Recovery may replay into the original local draft, never overwrite newer dirty text.
        if (!snapshot || snapshot.revision !== file.revision || (snapshot.text !== file.local && snapshot.text !== file.current)) { status.textContent = t('proposal.conflict'); return; }
        changes.push({ expected: { path: snapshot.path, revision: snapshot.revision, text: snapshot.text }, edits: [{ from: 0, to: snapshot.text.length, text: file.current }] });
      }
      if (!await confirmModal(t('proposal.restore'), t('proposal.restoreConfirm'), t('proposal.restore'))) return;
      const release = editor.reserveAll(changes.map(change => change.expected));
      if (!release) { status.textContent = t('proposal.conflict'); return; }
      busy = true;
      try {
        const result = await request<ProposalDecision>('/api/editor/proposals/recover', { project, task, id: proposal.id, version: proposal.version, snapshots: changes.map(change => change.expected) });
        status.textContent = editor.applyEditsAll(result.changes) ? t('proposal.note') : t('proposal.conflict');
      } catch (error) { status.textContent = errorMessage(error); }
      finally { release(); busy = false; }
    }, 'subtle'));
    for (const file of proposal.files) section.append(renderFile(file, decide));
    return section;
  };
  const renderFile = (file: ProposalFile, decide: (accept: boolean, target: { path: string; edit: string }) => Promise<void>) => {
    const section = el('section'); section.append(el('h4', '', file.path));
    const base = el('details'); base.append(el('summary', '', t('proposal.base')), el('pre', '', file.base));
    const local = el('details'); local.append(el('summary', '', t('proposal.local')), el('pre', '', file.local)); section.append(base, local);
    for (const edit of file.edits) {
      const hunk = el('section');
      hunk.append(button(`${edit.from}–${edit.to}`, () => { void context.open(file.path, file.local.slice(0, edit.from).split('\n').length); }, 'subtle'), el('p', '', t('proposal.local')), el('pre', '', file.local.slice(edit.from, edit.to)), el('p', '', t('proposal.ai')), el('pre', '', edit.text));
      if (edit.state === 'pending') hunk.append(button(t('proposal.accept'), () => decide(true, { path: file.path, edit: edit.id })), button(t('proposal.reject'), () => decide(false, { path: file.path, edit: edit.id }), 'subtle'));
      else hunk.append(el('p', '', t(`proposal.${edit.state}`)));
      section.append(hunk);
    }
    return section;
  };
  const generate = button(t('proposal.generate'), async () => {
    if (busy) return;
    const snapshots = editor.snapshots().filter(snapshot => selected.has(snapshot.path));
    if (!snapshots.length) { status.textContent = t('proposal.noFiles'); return; }
    busy = true; setLocked(generate, true);
    try {
      // Budget warnings need the same one-use acknowledgment as chat; without it the core refuses the run.
      const accounts = (await api.state()).settings.activeAccounts;
      if (!await confirmUsageRound({ project, task, ai: provider.value, account: accounts[provider.value] ?? 'default' })) return;
      const files = snapshots.map(snapshot => ({ path: snapshot.path, revision: snapshot.revision, text: snapshot.text, selection: snapshot.selection.from === snapshot.selection.to ? { from: 0, to: snapshot.text.length } : snapshot.selection }));
      const proposal = await request<EditorProposal>('/api/editor/proposals/generate', { project, task, files, instruction: instruction.value, ai: provider.value, ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(effort.value.trim() ? { effort: effort.value.trim() } : {}) });
      results.prepend(render(proposal)); announce(proposal); status.textContent = t('proposal.note');
    } catch (error) { status.textContent = errorMessage(error); }
    finally { busy = false; setLocked(generate, !provider.options.length); }
  });
  setLocked(generate, true); refreshFiles();
  node.append(el('h3', '', t('proposal.title')), el('p', '', t('proposal.note')), files, button(t('proposalMulti.refresh'), refreshFiles, 'subtle'), provider, model, effort, instruction, generate, button(t('proposal.stop'), async () => { await request('/api/editor/proposals/stop', { project, task }); }, 'subtle'), status, results);
  void request<{ providers: ProviderCapability[] }>('/api/ai/capabilities').then(({ providers }) => {
    for (const capability of providers.filter(p => p.readonly && p.ai !== 'mock')) { const option = el('option'); option.value = capability.ai; option.textContent = `${capability.ai} · ${capability.enforcement}`; provider.append(option); }
    setLocked(generate, !provider.options.length); if (!provider.options.length) status.textContent = t('cap.no');
  }).catch(() => { status.textContent = t('cap.no'); });
  void request<{ proposals: EditorProposal[] }>(query('/api/editor/proposals', { project, task })).then(({ proposals }) => {
    for (const proposal of proposals.reverse()) { results.append(render(proposal)); announce(proposal); }
  }).catch(error => { status.textContent = errorMessage(error); });
  return node;
}
