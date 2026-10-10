import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureCommand } from './process.ts';

/** Claude Code 的自訂設定目錄使用獨立 Keychain service；不可回退到其他帳戶的預設項目。 */
async function readKeychain(service: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const result = await captureCommand({ command: 'security', args: ['find-generic-password', '-s', service, '-w'], env, timeoutMs: 5000 });
  return result.ok ? result.stdout : null;
}

/** 憑證僅供用量查詢，不儲存、複製、更新或寫入日誌。 */
export async function readClaudeToken(env: NodeJS.ProcessEnv, keychain = readKeychain): Promise<string> {
  const configured = env['CLAUDE_CONFIG_DIR'];
  const directory = configured || path.join(env['HOME'] || env['USERPROFILE'] || os.homedir(), '.claude');
  const service = `Claude Code-credentials${configured ? `-${createHash('sha256').update(configured).digest('hex').slice(0, 8)}` : ''}`;
  let text = await keychain(service, env);
  if (!text) {
    try { text = await fs.readFile(path.join(directory, '.credentials.json'), 'utf8'); }
    catch { throw new Error('claude credentials not found'); }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('claude credentials invalid'); }
  if (!parsed || typeof parsed !== 'object' || !('claudeAiOauth' in parsed)) throw new Error('claude credentials invalid');
  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object' || !('accessToken' in oauth) || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) throw new Error('claude credentials invalid');
  if ('expiresAt' in oauth && typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) throw new Error('claude credentials expired');
  return oauth.accessToken;
}
