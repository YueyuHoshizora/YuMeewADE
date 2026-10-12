import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialVault } from '../credentials/vault.ts';
import type { CliCommandConfig } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { acquireWorkspaceLock } from '../shared/fsx.ts';
import { ClaudeCliProvider, claudeClientVersion, fetchClaudeQuota } from './claude.ts';
import { claudeCredentialToken, readClaudeCredentialRecord, readKeychain } from './claude-credentials.ts';
import { CodexCliProvider } from './codex.ts';
import { GeminiCliProvider } from './gemini.ts';
import { GrokCliProvider } from './grok.ts';
import { parseGrokCredentials } from './grok-credentials.ts';
import { fetchGrokQuota } from './grok-quota.ts';
import { captureCommand, minimalEnv } from './process.ts';
import type { CliProvider, CliRun, RunOutcome, SendOptions, CliEvent } from './provider.ts';
import { readCredentialFile as readBounded } from './credential-file.ts';

const MAX_BYTES = 1024 * 1024;
const FAILURE = 'Account credentials unavailable.';
const AUTH_ENV = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', 'CLAUDE_SESSION_INGRESS_TOKEN', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ACCESS_TOKEN', 'GROK_AUTH', 'GROK_AUTH_PATH', 'XAI_API_KEY', 'GROK_DEPLOYMENT_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_EXTRA_AUTH_KEY', 'GROK_ALPHA_TEST_KEY', 'GROK_TRACE_UPLOAD_CREDENTIALS_FILE', 'OTEL_EXPORTER_OTLP_HEADERS', 'GROK_INTERNAL_OTLP_HEADERS', 'GROK_LEADER_SOCKET', 'GROK_AUTH_PROVIDER_COMMAND']);
const AUTH_FILES = new Set(['auth.json', '.credentials.json', '.device-keys.json']);

type Ai = 'claude' | 'codex' | 'grok' | 'gemini';
/** Env variable that points each CLI at its config home; Gemini (agy) keeps everything under $HOME/.gemini. */
const HOME_VARIABLE: Record<Ai, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', grok: 'GROK_HOME', gemini: 'HOME' };
const GEMINI_TOKEN = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');
interface Profile { ai: Ai; source: string; key: string; runtime: string; authSource: string }
interface RuntimeLease { env: NodeJS.ProcessEnv; authFile: string; text: string; refs: number; unlock: () => Promise<void>; service?: string; socketDirectory?: string }
const runtimeAuthFile = (profile: Profile) => path.join(profile.runtime, profile.ai === 'claude' ? '.credentials.json' : profile.ai === 'gemini' ? GEMINI_TOKEN : 'auth.json');
/** Claude on macOS keeps its runtime OAuth in a keychain item derived from the config directory, not in a file. */
const managedKeychainService = (profile: Profile) => `Claude Code-credentials-${createHash('sha256').update(profile.runtime.normalize('NFC')).digest('hex').slice(0, 8)}`;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validate(ai: Ai, text: string): Record<string, unknown> {
  if (!text.length || Buffer.byteLength(text) > MAX_BYTES) throw new Error(FAILURE);
  const value: unknown = JSON.parse(text);
  if (!object(value)) throw new Error(FAILURE);
  if (ai === 'claude') {
    claudeCredentialToken(text, false);
    const oauth = value['claudeAiOauth'] as Record<string, unknown>;
    if (oauth['refreshToken'] !== undefined && (typeof oauth['refreshToken'] !== 'string' || !oauth['refreshToken'].trim())) throw new Error(FAILURE);
    if (oauth['expiresAt'] !== undefined && (typeof oauth['expiresAt'] !== 'number' || !Number.isFinite(oauth['expiresAt']))) throw new Error(FAILURE);
    if (oauth['scopes'] !== undefined && (!Array.isArray(oauth['scopes']) || !oauth['scopes'].every(scope => typeof scope === 'string'))) throw new Error(FAILURE);
  } else if (ai === 'codex') {
    const tokens = value['tokens'];
    const apiKey = value['OPENAI_API_KEY'];
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') throw new Error(FAILURE);
    if (value['last_refresh'] !== undefined && value['last_refresh'] !== null && (typeof value['last_refresh'] !== 'string' || !Number.isFinite(Date.parse(value['last_refresh'])))) throw new Error(FAILURE);
    if (typeof apiKey === 'string' && apiKey.trim()) return value;
    if (!object(tokens) || !['access_token', 'refresh_token', 'id_token'].every(key => typeof tokens[key] === 'string' && !!(tokens[key] as string).trim())) throw new Error(FAILURE);
    if (tokens['account_id'] !== undefined && tokens['account_id'] !== null && typeof tokens['account_id'] !== 'string') throw new Error(FAILURE);
  } else if (ai === 'gemini') {
    const token = value['token'];
    if (!object(token) || typeof token['access_token'] !== 'string' || !token['access_token'].trim()) throw new Error(FAILURE);
    for (const key of ['refresh_token', 'token_type', 'expiry']) if (token[key] !== undefined && typeof token[key] !== 'string') throw new Error(FAILURE);
    if (token['expiry'] !== undefined && !Number.isFinite(Date.parse(token['expiry'] as string))) throw new Error(FAILURE);
    for (const key of ['auth_method', 'id_token']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(FAILURE);
  } else {
    if (!Object.keys(value).length) throw new Error(FAILURE);
    for (const auth of Object.values(value)) {
      if (!object(auth) || !['oidc', 'external', 'api_key', 'web_login', 'grok'].includes(String(auth['auth_mode'])) || typeof auth['key'] !== 'string' || !auth['key'].trim() || typeof auth['user_id'] !== 'string' || typeof auth['create_time'] !== 'string' || !Number.isFinite(Date.parse(auth['create_time']))) throw new Error(FAILURE);
      for (const key of ['refresh_token', 'oidc_issuer', 'oidc_client_id']) if (auth[key] !== undefined && auth[key] !== null && typeof auth[key] !== 'string') throw new Error(FAILURE);
      if (auth['expires_at'] !== undefined && auth['expires_at'] !== null && (typeof auth['expires_at'] !== 'string' || !Number.isFinite(Date.parse(auth['expires_at'])))) throw new Error(FAILURE);
    }
  }
  return value;
}

/** Stored access tokens are short-lived (hours); a minute of margin avoids sending one that expires in flight. */
function accessExpired(ai: Ai, text: string, now = Date.now() + 60_000): boolean {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (ai === 'claude') {
    const expires = (value['claudeAiOauth'] as Record<string, unknown>)['expiresAt'];
    return typeof expires === 'number' && expires <= now;
  }
  if (ai !== 'grok') return false;
  return Object.values(value).some(auth => object(auth) && typeof auth['expires_at'] === 'string' && Date.parse(auth['expires_at']) <= now);
}

/** Original directories identify/import accounts; only encrypted records authorize execution. */
export class CredentialAccounts {
  private readonly vault: CredentialVault;
  private readonly root: string;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly env: NodeJS.ProcessEnv;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly stops = new Set<() => void>();
  private readonly runtimes = new Map<string, RuntimeLease>();
  private readonly operations = new Set<Promise<unknown>>();
  private closed = false;

  constructor(vault: CredentialVault, dataDir: string, envPassthrough: string[]) {
    this.vault = vault;
    this.root = path.join(path.resolve(dataDir), 'cli-accounts');
    this.sourceEnv = { ...process.env };
    this.env = minimalEnv(envPassthrough);
    for (const key of AUTH_ENV) delete this.env[key];
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS']) delete this.env[key];
  }

  /** A fresh isolated config directory for an OAuth login; kept beside the encrypted runtime state, never the user's own CLI folders. */
  newProfileDirectory(ai: string): string {
    if (!['claude', 'codex', 'grok', 'gemini'].includes(ai)) throw new Error(FAILURE);
    return path.join(this.root, 'profiles', ai, randomUUID());
  }

  private profile(ai: string, configDir?: string): Profile {
    if (!['claude', 'codex', 'grok', 'gemini'].includes(ai) || configDir === '') throw new Error(FAILURE);
    const provider = ai as Ai;
    const home = this.sourceEnv['HOME'] || this.sourceEnv['USERPROFILE'] || os.homedir();
    const variable = HOME_VARIABLE[provider];
    const source = path.resolve(configDir ?? (provider === 'gemini' ? home : this.sourceEnv[variable] ?? path.join(home, `.${provider}`)));
    const authSource = provider === 'gemini' ? path.join(source, GEMINI_TOKEN) : provider === 'grok' && configDir === undefined ? this.sourceEnv['GROK_AUTH_PATH'] || path.join(source, 'auth.json') : path.join(source, provider === 'claude' ? '.credentials.json' : 'auth.json');
    const key = JSON.stringify([configDir === undefined ? 'default' : 'profile', source, provider === 'grok' ? path.resolve(authSource) : '']);
    return { ai: provider, source, key, authSource, runtime: path.join(this.root, provider, createHash('sha256').update(key).digest('hex')) };
  }
  hasStored(ai: string, configDir?: string): boolean {
    const profile = this.profile(ai, configDir);
    return this.vault.has(profile.ai, profile.key);
  }

  private serial<T>(profile: Profile, operation: () => Promise<T>, releasing = false): Promise<T> {
    if (this.closed && !releasing) return Promise.reject(new Error(FAILURE));
    const key = `${profile.ai}:${profile.key}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }

  async import(ai: string, configDir?: string, replace = false): Promise<void> {
    const profile = this.profile(ai, configDir);
    await this.serial(profile, async () => {
      try {
        if (replace && this.runtimes.has(profile.runtime)) throw new Error(FAILURE);
        const current = await this.vault.read(profile.ai, profile.key);
        if (current !== null && !replace) { validate(profile.ai, current); return; }
        let text: string;
        if (profile.ai === 'claude') {
          const env = { ...this.sourceEnv };
          if (configDir !== undefined) env['CLAUDE_CONFIG_DIR'] = profile.source;
          text = await readClaudeCredentialRecord(env);
        } else if (profile.ai === 'codex') {
          // The official file/auto/keyring modes differ; never prefer a stale file over keyring in auto mode.
          let config = '';
          try { config = await readBounded(path.join(profile.source, 'config.toml')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const topLevel = config.split(/^\s*\[/m)[0] ?? '';
          const configuredStore = /^\s*cli_auth_credentials_store\s*=/m.test(topLevel);
          const mode = configuredStore ? /^\s*cli_auth_credentials_store\s*=\s*["'](file|auto|keyring|ephemeral)["']\s*(?:#.*)?$/m.exec(topLevel)?.[1] : 'file';
          if (!mode || mode === 'ephemeral') throw new Error(FAILURE);
          let keychain: string | null = null;
          if (mode !== 'file') {
            if (process.platform !== 'darwin') throw new Error(FAILURE);
            const canonical = await fs.realpath(profile.source).catch(() => profile.source);
            const account = `cli|${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
            const result = await captureCommand({ command: 'security', args: ['find-generic-password', '-s', 'Codex Auth', '-a', account, '-w'], env: this.env, timeoutMs: 5000, maxOutputBytes: MAX_BYTES });
            if (result.ok) keychain = result.stdout;
            else if (mode === 'keyring' || result.reason !== 'exit 44') throw new Error(FAILURE);
          }
          text = keychain ?? await readBounded(profile.authSource);
        } else text = await readBounded(profile.authSource);
        validate(profile.ai, text);
        await this.discardRuntimeAuth(profile);
        await this.vault.write(profile.ai, profile.key, text);
      } catch { throw new Error(FAILURE); }
    });
  }

  /** Runs the CLI's own OAuth login inside an isolated config directory; the CLI opens the browser and stores its result there. */
  async login(ai: string, configDir: string, command: string, args: string[], timeoutMs: number): Promise<void> {
    const profile = this.profile(ai, configDir);
    const variable = HOME_VARIABLE[profile.ai];
    const result = await captureCommand({ command, args, env: { ...this.env, [variable]: profile.source }, timeoutMs, maxOutputBytes: MAX_BYTES });
    if (!result.ok) throw new Error(FAILURE);
  }

  async remove(ai: string, configDir?: string): Promise<void> {
    const profile = this.profile(ai, configDir);
    await this.serial(profile, async () => {
      if (this.runtimes.has(profile.runtime)) throw new Error(FAILURE);
      try { await this.discardRuntimeAuth(profile); }
      catch { throw new Error(FAILURE); }
      await this.vault.remove(profile.ai, profile.key);
    });
  }

  /** Switching accounts: overwrite the App's default slot with an added account's stored credentials. The CLI's own login is never touched. */
  async activate(ai: string, configDir: string): Promise<void> {
    const source = this.profile(ai, configDir);
    const slot = this.profile(ai);
    await this.serial(slot, async () => {
      try {
        if (this.runtimes.has(slot.runtime)) throw new Error(FAILURE);
        const text = await this.vault.read(source.ai, source.key);
        if (text === null) throw new Error(FAILURE);
        validate(source.ai, text);
        await this.discardRuntimeAuth(slot);
        await this.vault.write(slot.ai, slot.key, text);
      } catch { throw new Error(FAILURE); }
    });
  }

  private async credential(profile: Profile): Promise<string> {
    const text = await this.vault.read(profile.ai, profile.key);
    if (text === null) throw new Error(FAILURE);
    validate(profile.ai, text);
    return text;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }

  /** Preparation and flush are locked; native callbacks share their account's auth store. */
  async withEnv<T>(ai: string, configDir: string | undefined, callback: (env: NodeJS.ProcessEnv) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const profile = this.profile(ai, configDir);
    const operation = (async () => {
      if (signal?.aborted || this.closed) throw new Error(FAILURE);
      const acquiring = this.serial(profile, async () => {
        if (signal?.aborted || this.closed) throw new Error(FAILURE);
        return this.acquire(profile);
      });
      const aborted = Promise.withResolvers<null>();
      const onAbort = () => aborted.resolve(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      let lease: RuntimeLease | null;
      try { lease = await Promise.race([acquiring, aborted.promise]); }
      finally { signal?.removeEventListener('abort', onAbort); }
      if (!lease) {
        this.track(acquiring.then(acquired => this.release(profile, acquired)).catch(() => {}));
        throw new Error(FAILURE);
      }
      try {
        if (signal?.aborted || this.closed) throw new Error(FAILURE);
        return await callback(lease.env);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new Error(FAILURE);
      } finally { await this.release(profile, lease); }
    })();
    return this.track(operation);
  }

  private async acquire(profile: Profile): Promise<RuntimeLease> {
    const shared = this.runtimes.get(profile.runtime);
    if (shared) { shared.refs++; return shared; }
    let text = await this.credential(profile);
    let lease: RuntimeLease | undefined;
    try {
      await this.checkAuthOverrides(profile);
      await this.prepare(profile);
      // Reuse the core's stale-PID recovery for each managed CLI home.
      const unlock = await acquireWorkspaceLock(profile.runtime, 0);
      lease = { env: { ...this.env }, authFile: runtimeAuthFile(profile), text, refs: 1, unlock };
      await this.seed(profile);
      if (profile.ai === 'claude') {
        lease.env['CLAUDE_CONFIG_DIR'] = profile.runtime;
        if (process.platform === 'darwin') lease.service = managedKeychainService(profile);
      } else if (profile.ai === 'codex') lease.env['CODEX_HOME'] = profile.runtime;
      else if (profile.ai === 'gemini') {
        lease.env['HOME'] = profile.runtime;
        lease.env['USERPROFILE'] = profile.runtime;
        await fs.mkdir(path.dirname(lease.authFile), { recursive: true, mode: 0o700 });
      } else {
        lease.socketDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ym-leader-'));
        await fs.chmod(lease.socketDirectory, 0o700);
        lease.env['GROK_HOME'] = profile.runtime;
        lease.env['GROK_AUTH_PATH'] = lease.authFile;
        lease.env['GROK_LEADER_SOCKET'] = path.join(lease.socketDirectory, 'leader.sock');
      }
      const saved = lease.service ? await readKeychain(lease.service, lease.env) : null;
      const recovered = saved ?? await readBounded(lease.authFile).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (recovered !== null) {
        validate(profile.ai, recovered);
        await this.vault.write(profile.ai, profile.key, recovered);
        text = recovered;
        lease.text = recovered;
      }
      if (lease.service) await this.deleteManagedKeychain(lease.service);
      await fs.rm(lease.authFile, { force: true });
      await fs.writeFile(lease.authFile, text, { mode: 0o600, flag: 'wx' });
      this.runtimes.set(profile.runtime, lease);
      return lease;
    } catch {
      if (lease) await this.cleanup(profile, lease);
      throw new Error(FAILURE);
    }
  }

  private release(profile: Profile, lease: RuntimeLease): Promise<void> {
    return this.serial(profile, async () => {
      try {
        const updated = lease.service ? await readKeychain(lease.service, lease.env) ?? await readBounded(lease.authFile) : await readBounded(lease.authFile);
        if (updated !== lease.text) {
          validate(profile.ai, updated);
          await this.vault.write(profile.ai, profile.key, updated);
          lease.text = updated;
        }
      } catch { throw new Error(FAILURE); }
      finally {
        if (--lease.refs === 0) {
          this.runtimes.delete(profile.runtime);
          await this.cleanup(profile, lease);
        }
      }
    }, true);
  }

  /**
   * A killed core never reaches release(), so its last run's auth file (or managed keychain item) stays in the
   * runtime home and acquire() would recover it over the vault. Explicit activate/import/remove decide the
   * account instead, so the leftover is dropped first; another live process still holding the home refuses.
   */
  private async discardRuntimeAuth(profile: Profile): Promise<void> {
    try { await fs.lstat(profile.runtime); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const unlock = await acquireWorkspaceLock(profile.runtime, 0);
    try {
      if (profile.ai === 'claude' && process.platform === 'darwin') await this.deleteManagedKeychain(managedKeychainService(profile));
      for (const name of await fs.readdir(profile.runtime)) {
        if (AUTH_FILES.has(name) || name.startsWith('auth.json.') || name.startsWith('.credentials.json.')) await fs.rm(path.join(profile.runtime, name), { force: true });
      }
      await fs.rm(runtimeAuthFile(profile), { force: true });
    } finally { await unlock(); }
  }

  private async cleanup(profile: Profile, lease: RuntimeLease): Promise<void> {
    try { if (lease.service) await this.deleteManagedKeychain(lease.service); }
    finally {
      try {
        for (const name of await fs.readdir(profile.runtime)) {
          if (AUTH_FILES.has(name) || name.startsWith('auth.json.') || name.startsWith('.credentials.json.')) await fs.rm(path.join(profile.runtime, name), { force: true });
        }
        await fs.rm(lease.authFile, { force: true });
        if (lease.socketDirectory) await fs.rm(lease.socketDirectory, { recursive: true, force: true });
      } finally { await lease.unlock(); }
    }
  }

  private async deleteManagedKeychain(service: string): Promise<void> {
    const result = await captureCommand({ command: 'security', args: ['delete-generic-password', '-s', service], env: this.env, timeoutMs: 5000 });
    // security uses 44 for errSecItemNotFound; other errors must not leave managed credentials behind.
    if (!result.ok && result.reason !== 'exit 44') throw new Error(FAILURE);
  }

  private async checkAuthOverrides(profile: Profile): Promise<void> {
    if (profile.ai === 'claude') {
      for (const name of ['settings.json', 'settings.local.json']) {
        let settings: unknown;
        try { settings = JSON.parse(await readBounded(path.join(profile.source, name))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (!object(settings)) throw new Error(FAILURE);
        if (settings['apiKeyHelper']) throw new Error(FAILURE);
        if (object(settings['env']) && Object.keys(settings['env']).some(key => AUTH_ENV.has(key) || key === 'CLAUDE_CONFIG_DIR')) throw new Error(FAILURE);
      }
    } else if (profile.ai === 'grok') {
      let config = '';
      try { config = await readBounded(path.join(profile.source, 'config.toml')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (/^\s*(?:auth_provider_command|api_key)\s*=/m.test(config) || /^\s*\[auth_provider(?:\.|\])/m.test(config)) throw new Error(FAILURE);
    }
  }

  private async prepare(profile: Profile): Promise<void> {
    let current = path.parse(this.root).root;
    for (const component of path.relative(current, profile.runtime).split(path.sep)) {
      current = path.join(current, component);
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(FAILURE);
    }
    await fs.chmod(profile.runtime, 0o700);
  }

  private async seed(profile: Profile): Promise<void> {
    try { await fs.access(path.join(profile.runtime, '.seeded')); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      const sourceRoot = await fs.realpath(profile.ai === 'gemini' ? path.join(profile.source, '.gemini') : profile.source);
      await fs.cp(sourceRoot, profile.ai === 'gemini' ? path.join(profile.runtime, '.gemini') : profile.runtime, { recursive: true, force: false, errorOnExist: false, filter: async (source) => {
        const name = path.basename(source);
        const info = await fs.lstat(source);
        return !info.isSymbolicLink() && (info.isDirectory() || info.isFile()) && !AUTH_FILES.has(name) && name !== 'antigravity-oauth-token' && !name.startsWith('auth.json.') && !name.startsWith('.credentials.json.') && !['.yumeewade', '.seeded', 'leader.sock'].includes(name);
      } });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (profile.ai === 'claude' && profile.source === path.join(this.sourceEnv['HOME'] || os.homedir(), '.claude')) {
      await fs.copyFile(path.join(path.dirname(profile.source), '.claude.json'), path.join(profile.runtime, '.claude.json'), constants.COPYFILE_EXCL).catch(error => { if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
    }
    if (profile.ai === 'claude') {
      const file = path.join(profile.runtime, '.claude.json');
      try {
        const metadata: unknown = JSON.parse(await readBounded(file));
        if (!object(metadata)) throw new Error(FAILURE);
        delete metadata['primaryApiKey'];
        delete metadata['apiKeyHelper'];
        await fs.writeFile(file, JSON.stringify(metadata), { mode: 0o600 });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await fs.writeFile(path.join(profile.runtime, '.seeded'), '', { mode: 0o600, flag: 'wx' });
  }

  provider(ai: Ai, config: CliCommandConfig): CliProvider {
    const factory = (env: NodeJS.ProcessEnv): CliProvider => ai === 'claude' ? new ClaudeCliProvider(config, [], env) : ai === 'codex' ? new CodexCliProvider({ ...config, baseArgs: [...config.baseArgs, '-c', 'cli_auth_credentials_store="file"'], quotaArgs: config.quotaArgs.length ? [...config.quotaArgs, '-c', 'cli_auth_credentials_store="file"'] : [] }, [], env) : ai === 'gemini' ? new GeminiCliProvider(config, [], env) : new GrokCliProvider(config, [], env);
    const base = factory(this.env);
    return {
      name: ai, dangerous: config.fullAccess,
      supportsReadonly: base.supportsReadonly === true,
      supportsApprovals: base.supportsApprovals === true,
      ...(base.readonlyEnforcement ? { readonlyEnforcement: base.readonlyEnforcement } : {}),
      available: () => base.available(),
      quota: async (configDir) => {
        if (ai === 'gemini') return this.withEnv(ai, configDir, env => factory(env).quota!(env['HOME']));
        if (ai === 'codex') return this.withEnv(ai, configDir, env => factory(env).quota!(env['CODEX_HOME']));
        const profile = this.profile(ai, configDir);
        return this.track((async () => {
          if (this.closed) throw new Error(FAILURE);
          let text = await this.credential(profile);
          if (config.authRefreshArgs.length && accessExpired(ai, text)) {
            // Only the CLI may refresh OAuth; running it under a lease flushes the refreshed record back into the vault.
            await this.withEnv(ai, configDir, async env => {
              const result = await captureCommand({ command: config.command, args: config.authRefreshArgs, env, timeoutMs: 60_000, maxOutputBytes: MAX_BYTES });
              if (!result.ok) throw new Error(FAILURE);
            });
            text = await this.credential(profile);
          }
          if (ai === 'claude') return fetchClaudeQuota({}, 15_000, undefined, async () => claudeCredentialToken(text), await claudeClientVersion(config.command, this.env));
          return fetchGrokQuota(undefined, this.env, { readCredentials: async () => parseGrokCredentials(JSON.parse(text), this.sourceEnv) });
        })());
      },
      commands: (cwd, configDir) => this.withEnv(ai, configDir, async env => await factory(env).commands?.(cwd, env[HOME_VARIABLE[ai]]) ?? []),
      resolveCommand: (text, cwd, configDir) => this.withEnv(ai, configDir, async env => {
        const provider = factory(env);
        if (!provider.resolveCommand) throw new AppError('bad_request', 'slash_unsupported');
        return provider.resolveCommand(text, cwd, env[HOME_VARIABLE[ai]]);
      }),
      send: (opts: SendOptions, onEvent: (event: CliEvent) => void): CliRun => {
        const controller = new AbortController();
        let run: CliRun | undefined;
        const stop = () => { controller.abort(); run?.stop(); };
        this.stops.add(stop);
        const done: Promise<RunOutcome> = this.withEnv(ai, opts.configDir, async env => {
          if (controller.signal.aborted) return { ok: false, stopped: true };
          const directory = env[HOME_VARIABLE[ai]];
          if (!directory) throw new Error(FAILURE);
          run = factory(env).send({ ...opts, configDir: directory }, onEvent);
          return run.done;
        }, controller.signal).catch(() => {
          if (controller.signal.aborted) return { ok: false, stopped: true };
          onEvent({ type: 'error', reason: FAILURE });
          return { ok: false, stopped: false, reason: FAILURE };
        }).finally(() => { this.stops.delete(stop); });
        return { stop, done };
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.stops) stop();
    while (this.operations.size || this.queues.size) await Promise.allSettled([...this.operations, ...this.queues.values()]);
  }
}
