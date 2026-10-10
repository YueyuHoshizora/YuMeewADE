import type { SearchResult } from '../../shared/types.ts';
import { query, request } from '../api.ts';
import { t } from '../i18n/index.ts';
import { el, input, link, run, taskHash, type View } from '../components/dom.ts';
import { searchParts } from '../components/search-match.ts';

export function searchView(): View {
  const node = el('div', 'page search-page');
  const search = input('', t('search.placeholder'));
  search.type = 'search';
  search.setAttribute('aria-label', t('search.title'));
  const results = el('div', 'search-results');
  const status = el('p', 'muted');
  status.setAttribute('role', 'status');
  node.append(el('h1', '', t('search.title')), search, status, results);
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
          const data = await request<SearchResult>(query('/api/search', { q: term }));
          if (!alive || current !== serial) return;
          for (const hit of data.hits) {
            const hash = taskHash(hit.project, hit.task);
            const target = link('', hit.kind === 'chat' && hit.index !== undefined ? `${hash}?index=${hit.index}` : hash, 'search-hit');
            target.append(el('strong', '', `${hit.project} › ${hit.title}`));
            if (hit.role) target.append(el('span', 'muted', t(hit.role === 'user' ? 'chat.you' : hit.role === 'assistant' ? 'ai.label' : 'common.details')));
            const snippet = el('p');
            for (const part of searchParts(hit.snippet, term)) {
              snippet.append(part.match ? el('mark', '', part.text) : document.createTextNode(part.text));
            }
            target.append(snippet);
            results.append(target);
          }
          status.textContent = data.truncated ? t('search.truncated') : data.hits.length ? '' : t('common.empty');
        } catch (error) {
          if (alive && current === serial) { status.textContent = ''; throw error; }
        }
      });
    }, 250);
  };
  return { node, dispose: () => { alive = false; serial++; window.clearTimeout(timer); } };
}
