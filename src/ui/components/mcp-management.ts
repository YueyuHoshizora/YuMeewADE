import type { McpAi, McpInput, McpList, McpTransport } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { area, button, card, confirmModal, el, field, input, row, select, UserError, type ViewContext } from './dom.ts';
import { aiLabel } from './display.ts';

export function mcpPanel(context: ViewContext): HTMLElement {
  const panel = card(t('mcp.title')); panel.append(el('p', 'muted', t('mcp.accountHint')));
  for (const info of context.state.ais.filter(ai => ai.available && ['claude', 'codex', 'grok', 'gemini'].includes(ai.name))) {
    const ai = info.name as McpAi; const node = el('details'); node.append(el('summary', '', aiLabel(ai)));
    const content = el('div'); node.append(content); panel.append(node);
    let loaded = false;
    async function load(): Promise<void> {
      const result = await request<McpList>(query('/api/mcp/list', { ai }));
      content.replaceChildren();
      if (!result.supported) { content.append(el('p', 'muted', t('mcp.unsupported'))); return; }
      content.append(button(t('mcp.refresh'), load));
      for (const server of result.servers) {
        const details = el('div'); details.append(el('strong', '', server.name), el('p', 'muted', `${server.transport} · ${server.command ?? server.url ?? '—'} · ${server.scope} · ${t(`mcp.status.${server.status}`)}`));
        if (server.envKeys.length) details.append(el('p', 'muted', `${t('mcp.env')}: ${server.envKeys.join(', ')}`));
        if (server.headerKeys.length) details.append(el('p', 'muted', `${t('mcp.headers')}: ${server.headerKeys.join(', ')}`));
        details.append(button(t('common.remove'), async () => {
          if (!await confirmModal(t('mcp.removeTitle'), t('mcp.removeConfirm', { name: server.name }), t('common.remove'))) return;
          await request('/api/mcp/remove', { ai, name: server.name, confirmed: true }); await load();
        }, 'danger')); content.append(details);
      }
      if (!result.servers.length) content.append(el('p', 'muted', t('common.empty')));
      const name = input(); name.maxLength = 80;
      const transport = select(result.transports.map(value => ({ value, label: value })), 'stdio');
      const command = input(); command.maxLength = 4096;
      const args = area(); args.maxLength = 131072;
      const env = area(); env.maxLength = 131072;
      const url = input(); url.type = 'url'; url.maxLength = 4096;
      const headers = area(); headers.maxLength = 131072;
      for (const control of [command, args, env, url, headers]) { control.autocomplete = 'off'; control.spellcheck = false; }
      const local = el('div'); local.append(field(t('mcp.command'), command), field(t('mcp.args'), args), field(t('mcp.env'), env));
      const remote = el('div'); remote.append(field(t('mcp.url'), url), field(t('mcp.headers'), headers)); remote.hidden = true;
      transport.onchange = () => { local.hidden = transport.value !== 'stdio'; remote.hidden = transport.value === 'stdio'; };
      function values(raw: string, separator: string): Record<string, string> {
        const result: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const line of raw.split('\n').filter(line => line.trim())) {
          const at = line.indexOf(separator); const key = line.slice(0, at).trim();
          if (at <= 0 || Object.hasOwn(result, key)) throw new UserError(t('mcp.invalid'));
          result[key] = line.slice(at + 1).trim();
        }
        return result;
      }
      content.append(field(t('common.name'), name), field(t('mcp.transport'), transport), local, remote, el('p', 'warning', t('mcp.secretHint')), row(button(t('mcp.add'), async () => {
        const kind = transport.value as McpTransport;
        const server: McpInput = kind === 'stdio' ? { name: name.value.trim(), transport: kind, command: command.value.trim(), args: args.value ? args.value.split('\n') : [], env: values(env.value, '=') } : { name: name.value.trim(), transport: kind, url: url.value.trim(), headers: values(headers.value, ':') };
        await request('/api/mcp/add', { ai, server }); env.value = ''; headers.value = ''; await load();
      }, 'primary')));
    }
    node.ontoggle = () => { if (node.open && !loaded) { loaded = true; void load().catch(() => { loaded = false; content.replaceChildren(el('p', 'warning', t('mcp.failed')), button(t('mcp.refresh'), load)); }); } };
  }
  return panel;
}
