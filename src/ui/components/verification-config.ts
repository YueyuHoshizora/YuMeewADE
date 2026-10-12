import { AUTO_FIX_MAX, type VerificationCheck } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, el, field, input, modal, row, select, toast, type ViewContext } from './dom.ts';

export function verificationConfigButton(context: ViewContext, projectId: string): HTMLElement {
  return button(t('verification.configure'), () => {
    const project = context.state.projects.find(item => item.id === projectId);
    if (!project) return;
    const list = el('div', 'form');
    const controls: { node: HTMLElement; name: HTMLInputElement; command: HTMLInputElement }[] = [];
    const add = (check: VerificationCheck) => {
      const name = input(check.name); name.maxLength = 80; name.required = true;
      const command = input(check.command); command.maxLength = 500; command.required = true;
      const node = row(field(t('verification.name'), name), field(t('verification.command'), command));
      const control = { node, name, command };
      node.append(button(t('verification.remove'), () => { controls.splice(controls.indexOf(control), 1); node.remove(); }));
      controls.push(control); list.append(node);
    };
    for (const check of project.checks.length ? project.checks : project.verify ? [{ name: 'verify', command: project.verify }] : []) add(check);
    const requireVerification = input(); requireVerification.type = 'checkbox'; requireVerification.checked = project.requireVerification;
    const autoFix = select(Array.from({ length: AUTO_FIX_MAX + 1 }, (_, n) => ({ value: String(n), label: String(n) })), String(project.autoFix));
    const inputs = input(project.verificationInputs?.inputs?.join(', ') ?? '');
    const outputs = input(project.verificationInputs?.outputs?.join(', ') ?? '');
    modal(t('verification.configure'), el('p', 'muted', t('verification.hint')), list,
      button(t('verification.add'), () => { if (controls.length < 20) add({ name: '', command: '' }); }),
      field(t('verification.require'), requireVerification), field(t('project.autoFix'), autoFix),
      field(t('verification.inputs'), inputs), field(t('verification.outputs'), outputs),
      button(t('common.save'), async () => {
        if (controls.some(control => !control.name.reportValidity() || !control.command.reportValidity())) return;
        const checks = controls.map(control => ({ name: control.name.value.trim(), command: control.command.value.trim() }));
        const patterns = (value: string) => value.split(',').map(pattern => pattern.trim()).filter(Boolean);
        await request('/api/project/update', { project: projectId, patch: { checks, requireVerification: requireVerification.checked, autoFix: Number(autoFix.value), verificationInputs: { ...(inputs.value.trim() ? { inputs: patterns(inputs.value) } : {}), outputs: patterns(outputs.value) } } });
        await context.refresh(); toast(t('common.saved'));
      }));
  });
}
