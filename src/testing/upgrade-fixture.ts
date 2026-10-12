import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** A pre-checks/workflow ledger remains readable without rewriting user-authored bytes. */
export async function seedUpgradeFixture(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>([
    ['Projects/UpgradeRetained/PROJECT.md', Buffer.from('---\nname: UpgradeRetained\nstatus: 進行中\nupdated: 2026-10-11\ndescription: retained legacy project\nparent:\nbody:\nphases: []\nrelated: []\nissues: []\nverify:\ncustomUserField: preserve-me\n---\n# 備註\n使用者正文必須保留。\n')],
    ['Projects/UpgradeRetained/.ai/tasks/20261011-001.md', Buffer.from('---\nid: 20261011-001\ntitle: Retained legacy task\nstate: 未開始\nworkspace: direct\nupdated: 2026-10-11\n---\n## 步驟\n- [x] Already completed\n- [ ] Preserve next step\n\n## 備註\n保留人工備註\n\n## 下一步\nContinue here\n')],
    ['Projects/UpgradeRetained/.ai/chat/20261011-001.jsonl', Buffer.from('{"role":"user","text":"保留歷史對話","at":"2026-10-11T00:00:00.000Z","request":"legacy-request"}\n')],
    ['Projects/UpgradeRetained/.ai/attachments/20261011-001/retained.bin', Buffer.from([0, 1, 2, 255, 128])],
    ['.yumeewade/recovery/user-retained-snapshot/content.bin', Buffer.from('private retained recovery bytes\n')],
  ]);
  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
  }
  return files;
}

export async function assertUpgradeFixture(root: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [relative, expected] of files) assert.deepEqual(await fs.readFile(path.join(root, relative)), expected, `Upgrade changed retained ${relative}`);
}
