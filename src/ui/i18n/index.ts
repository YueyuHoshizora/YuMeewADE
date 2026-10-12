// 前端 i18n：無相依。語言順序：localStorage → navigator.language → zh-TW。
// 靜態文字用 data-i18n／data-i18n-placeholder 屬性，動態文字用 t()；切換語言後呼叫 applyStatic 並重繪。

import { de } from './de.ts';
import { en } from './en.ts';
import { fr } from './fr.ts';
import { it } from './it.ts';
import { ja } from './ja.ts';
import { zhCN } from './zh-CN.ts';
import { zhTW, type MessageKey } from './zh-TW.ts';

export const LOCALES = ['zh-TW', 'zh-CN', 'en', 'ja', 'de', 'fr', 'it'] as const;
export type Locale = (typeof LOCALES)[number];

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { 'zh-TW': zhTW, 'zh-CN': zhCN, en, ja, de, fr, it };
const STORAGE_KEY = 'yumeewade.lang';

let current: Locale = detect();

function detect(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith('zh')) return nav.includes('cn') || nav.includes('hans') || nav.includes('sg') ? 'zh-CN' : 'zh-TW';
  const short = nav.slice(0, 2);
  const hit = LOCALES.find((l) => l === short);
  return hit ?? 'zh-TW';
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

export function localeName(locale: Locale): string {
  return MESSAGES[locale]['lang.name'];
}

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = MESSAGES[current][key] ?? zhTW[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

/** Joins a translated label and a value with the locale's separator (full-width colon in CJK, spaced colon in French). */
export function labelValue(label: string, value: string | number): string { return t('common.labelValue', { label, value }); }

/** 動態組出的鍵（例如操作紀錄的 action）是否有翻譯；沒有就由呼叫端顯示原值。 */
export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(zhTW, key);
}

/** 把 data-i18n／data-i18n-placeholder 屬性對應的文字套到 DOM。 */
export function applyStatic(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset['i18n'] as MessageKey);
  for (const node of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset['i18nPlaceholder'] as MessageKey);
  }
  document.documentElement.lang = current;
}
