import type { ProviderCapability } from '../../shared/types.ts';
import { request } from '../api.ts';
import { labelValue, t } from '../i18n/index.ts';
import { el } from './dom.ts';
export function mountProviderCapabilities(): HTMLElement {
  const node = el('section'); node.append(el('h3', '', t('cap.title')));
  void request<{ providers: ProviderCapability[] }>('/api/ai/capabilities').then(({ providers }) => {
    for (const provider of providers.filter(p => p.ai !== 'mock')) {
      const row = el('section'); row.append(el('h4', '', `${provider.ai} · ${provider.transport}`));
      for (const [key, supported] of [['approvals', provider.approvals], ['readonly', provider.readonly], ['slash', provider.slash !== 'none'], ['resume', provider.resume], ['usage', provider.usage]] as const) row.append(el('p', '', labelValue(t(`cap.${key}`), t(supported ? 'cap.yes' : 'cap.no'))));
      row.append(el('p', '', t(`cap.${provider.limitation}`))); node.append(row);
    }
  }).catch(() => node.append(el('p', 'warning', t('cap.no'))));
  return node;
}
