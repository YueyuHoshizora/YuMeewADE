import type { SearchResult } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, field, input, link, run, taskHash, type View, type ViewContext } from '../components/dom.ts';
import { searchParts } from '../components/search-match.ts';

export function searchView(context: ViewContext, params: URLSearchParams): View {
  const node = el('div', 'page search-page');
  const search = input('', t('search.placeholder'));
  search.type = 'search';
  search.setAttribute('aria-label', t('search.title'));
  const results = el('div', 'search-results');
  const status = el('p', 'muted');
  status.setAttribute('role', 'status');
  // Opened from a task: offer to stay within it (checked), so long, partly unmounted conversations can be searched fully.
  const project = params.get('project') ?? ''; const taskId = params.get('task') ?? '';
  const task = context.state.projects.find(p => p.id === project)?.tasks.find(item => item.id === taskId);
  const scoped = input(); scoped.type = 'checkbox'; scoped.checked = !!task;
  node.append(el('h1', '', t('search.title')), search, ...(task ? [field(t('search.scopeTask', { title: task.title }), scoped)] : []), status, results);
  scoped.onchange = () => search.dispatchEvent(new Event('input'));
  // Opening search means typing next; focus the box once the page is in the document.
  requestAnimationFrame(() => { if (search.isConnected && !node.contains(document.activeElement)) search.focus({ preventScroll: true }); });
  let alive = true;
  let serial = 0;
  let timer = 0;
  search.oninput = () => {
    window.clearTimeout(timer);
    const term = search.value.trim();
    const current = ++serial;
    results.replaceChildren();
    status.textContent = '';
    if (!term) return;
    timer = window.setTimeout(() => {
      void run(async () => {
        status.textContent = t('common.loading');
        try {
          const data = await request<SearchResult>(query('/api/search', { q: term, ...(task && scoped.checked ? { project, task: taskId } : {}) }));
          if (!alive || current !== serial) return;
          for (const hit of data.hits) {
            const hash = taskHash(hit.project, hit.task);
            const target = link('', hit.kind === 'chat' && hit.index !== undefined ? `${hash}?index=${hit.index}` : hit.kind === 'record' ? `${hash}?record=1` : hash, 'search-hit');
            target.append(el('strong', '', `${hit.project} › ${hit.title}`));
            if (hit.role) target.append(el('span', 'muted', t(hit.role === 'user' ? 'chat.you' : hit.role === 'assistant' ? 'ai.label' : 'common.details')));
            else if (hit.kind === 'record') target.append(el('span', 'muted', t('tasks.record')));
            const snippet = el('p');
            for (const part of searchParts(hit.snippet, term.normalize('NFC'))) {
              snippet.append(part.match ? el('mark', '', part.text) : document.createTextNode(part.text));
            }
            target.append(snippet);
            results.append(target);
          }
          status.textContent = data.partial ? t('search.partial') : data.truncated ? t('search.truncated') : data.hits.length ? '' : t('search.noResults', { q: term });
        } catch (error) {
          if (alive && current === serial) { status.textContent = ''; throw error; }
        }
      });
    }, 250);
  };
  return { node, dispose: () => { alive = false; serial++; window.clearTimeout(timer); } };
}
