import type { CareHealth } from '../../shared/types.ts';
import { request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { button, card, el, input, readLocal, row, run, storeLocal, type ViewContext } from './dom.ts';
import { openUsageDetails } from './usage-details.ts';
import { aiLabel } from './display.ts';

const installers: Record<string, { url: string; unix: string; windows: string }> = {
  claude: { url: 'https://docs.anthropic.com/claude-code', unix: 'curl -fsSL https://claude.ai/install.sh | bash', windows: 'irm https://claude.ai/install.ps1 | iex' },
  codex: { url: 'https://github.com/openai/codex', unix: 'npm install -g @openai/codex', windows: 'npm install -g @openai/codex' },
  grok: { url: 'https://github.com/xai-org/grok-build', unix: 'curl -fsSL https://x.ai/cli/install.sh | bash', windows: 'irm https://x.ai/cli/install.ps1 | iex' },
  gemini: { url: 'https://antigravity.google/docs/cli/install/', unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', windows: 'irm https://antigravity.google/cli/install.ps1 | iex' },
};
export function cliGuidance(context: ViewContext): HTMLElement {
  const entries = el('div');
  const refresh = async () => {
    const health = await request<CareHealth>('/api/care/health');
    entries.replaceChildren(...health.clis.map(cli => {
      const state = !cli.available ? 'missing' : cli.loginState === 'stored' ? 'ready' : cli.loginState === 'missing' ? 'noAccount' : 'installed';
      const item = el('section'); item.append(el('h3', '', aiLabel(cli.name)), el('p', '', t(`onboarding.${state}`)));
      const installer = installers[cli.name];
      if (!cli.available && installer) {
        const docs = el('a', 'button', t('onboarding.docs')); docs.href = installer.url; docs.target = '_blank'; docs.rel = 'noopener noreferrer';
        const command = input(); command.readOnly = true; command.value = /Win/i.test(window.yumeewade?.platform ?? navigator.platform) ? installer.windows : installer.unix; command.onfocus = () => command.select();
        item.append(docs, command, button(t('onboarding.copy'), () => navigator.clipboard.writeText(command.value)));
      } else if (cli.loginState !== 'stored') {
        item.append(button(t('usage.addAccount'), () => openUsageDetails(() => context.state, () => context.state.usage, context.refresh, cli.name, true)));
      }
      return item;
    }));
  };
  const panel = card(t('onboarding.title'), el('p', 'muted', t('onboarding.manual')), button(t('ai.refresh'), refresh), entries);
  void run(refresh); return panel;
}
export function onboardingBanner(context: ViewContext): HTMLElement {
  const node = el('aside', 'warning'); node.hidden = true;
  const key = `yumeewade.onboarding.dismissed.${context.state.root}`;
  const refresh = async () => {
    if (readLocal(key, false)) return;
    const health = await request<CareHealth>('/api/care/health');
    node.hidden = health.clis.some(cli => cli.available && cli.loginState === 'stored');
  };
  node.append(el('p', '', t('onboarding.banner')), row(button(t('onboarding.title'), () => { location.hash = '#/settings'; }), button(t('onboarding.dismiss'), () => { storeLocal(key, true); node.hidden = true; })));
  void run(refresh); return node;
}
