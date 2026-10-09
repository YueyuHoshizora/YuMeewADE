import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotes } from './release.ts';

test('發佈說明只擷取標籤對應版本，保留子標題', () => {
  const changelog = '# Changelog\n\n## [1.1.0] - 2026-11-01\n未來版本\n\n## [1.0.0] - 2026-10-10\n\n### 新增\n- 灰貓圖示\n\n### 修正\n- 核心關閉\n\n## [0.9.0]\n舊版本\n';
  assert.equal(releaseNotes(changelog, 'v1.0.0'), '### 新增\n- 灰貓圖示\n\n### 修正\n- 核心關閉');
  assert.equal(releaseNotes(changelog.replaceAll('\n', '\r\n'), 'v0.9.0'), '舊版本');
});

test('沒有對應版本或沒有內容則使用 GitHub 自動說明', () => {
  assert.equal(releaseNotes('## [1.0.0]\n版本一', 'v1.0.1'), null);
  assert.equal(releaseNotes('## [1.0.0]\n\n## [0.9.0]\n舊版本', 'v1.0.0'), null);
});
