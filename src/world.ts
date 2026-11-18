/**
 * 夸克网盘 World：把包内的 quarkclouddrive 命令行工具接成工具、事件与面板。
 * 登录态写在部署目录的 `.quarkclouddrive/`，授权码存在部署 .env。
 */
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { Language } from 'cortico/core/language.ts';
import {
  QUARK_DEFAULTS,
  QUARK_SECRETS,
  type QuarkConfigSection,
  type QuarkPanelState,
  quarkConfigGroup,
  text,
} from './config.ts';
import {
  QuarkCliError,
  fetchUserInfo,
  formatBytes,
  loginWithCode,
  maskAuthCode,
  toAccount,
  unauthorize,
  vipLabel,
  type QuarkAccount,
} from './cli.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const ACCOUNT_PANEL = 'account';
const AUTH_PANEL = 'auth';

/** 全部工具的声明；定义里的 describe 与 `tools()` 都取它。 */
export const QUARK_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'qk_get_user_info',
    description: '读夸克网盘当前账号的昵称、网盘空间与会员状态。未登录时先调 qk_login。',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'qk_login',
    description: '用授权码登录夸克网盘。授权码从部署 .env 的 QUARK_AUTH_CODE 读；用户没填时如实说明。',
    tags: ['write'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'qk_unauthorize',
    description: '解除夸克网盘授权，返回解绑地址。',
    tags: ['act'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export interface QuarkWorldOptions {
  /** `worlds.quark` 的活引用。 */
  cfg: QuarkConfigSection;
  timezone: string;
  botDir: string;
  secret(name: string): string;
  storeSecret(name: string, value: string): void;
}

export class QuarkWorld implements World {
  readonly id = 'quark';

  private readonly opts: QuarkWorldOptions;

  /** 最近一次读到的账号信息；启动时为空，面板与工具按需刷新。 */
  private account: QuarkAccount | null = null;

  constructor(opts: QuarkWorldOptions) {
    this.opts = opts;
  }

  /** 环境提示词不带占位符；返回空对象即保留模板全文。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [this.getUserInfoTool(), this.loginTool(), this.unauthorizeTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    return {
      label: text.moduleLabel,
      lamps: [this.account
        ? { label: text.loggedIn, state: 'online' as const }
        : { label: text.loggedOut, state: 'offline' as const }],
      badges: [
        { label: text.vipType, value: this.account ? vipLabel(this.account.vipType) : text.loggedOut, tone: this.account ? 'on' as const : 'off' as const },
      ],
      panels: [
        { id: ACCOUNT_PANEL, title: text.accountTitle, getMethods: ['state'] },
        { id: AUTH_PANEL, title: text.authTitle },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      config: [quarkConfigGroup(language)],
      promptDocs: [
        {
          key: 'worlds.quark.envPrompt',
          title: `${text.moduleLabel} · 环境提示词`,
          description: '这个 World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
      storage: [this.storagePart()],
    };
  }

  async start(host: WorldHost): Promise<void> {
    await host.pushEvent({
      type: 'quark.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: '夸克网盘 World 已挂载。',
    });
    await this.refresh(host);
  }

  async stop(): Promise<void> {}

  // ---------------------------------------------------------------- 面板数据面

  private panelState(): QuarkPanelState {
    const code = this.opts.secret(QUARK_SECRETS.authCode).trim();
    return {
      loggedIn: !!this.account?.nickname,
      nickname: this.account?.nickname ?? null,
      vipType: this.account?.vipType ?? null,
      used: this.account?.used ?? null,
      capacity: this.account?.capacity ?? null,
      authCodeSet: !!code,
      maskedAuthCode: code ? maskAuthCode(code) : null,
      message: null,
    };
  }

  private storagePart() {
    const dir = join(this.opts.botDir, '.quarkclouddrive');
    return {
      key: 'quark-drive',
      label: '夸克网盘登录态',
      kind: 'disk' as const,
      location: dir,
      danger: true,
      note: '清除后本机授权失效，需要重新填授权码登录。',
      stat: () => (existsSync(dir) ? '有登录态' : '空'),
      clear: async () => {
        const { rm } = await import('node:fs/promises');
        await rm(dir, { recursive: true, force: true });
        this.account = null;
        return '已清除登录态';
      },
    };
  }

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === ACCOUNT_PANEL) {
      if (method === 'state') return this.panelState();
      throw new Error(text.unknownMethod(method));
    }
    if (panel === AUTH_PANEL) {
      switch (method) {
        case 'state':
          return this.panelState();
        case 'saveCode':
          return this.saveCode(String(args[0] ?? ''));
        case 'login':
          return this.login(String(args[0] ?? ''));
        case 'logout':
          return this.logout();
        default:
          throw new Error(text.unknownMethod(method));
      }
    }
    throw new Error(text.unknownPanel(panel));
  }

  private saveCode(code: string): QuarkPanelState {
    const value = code.trim();
    this.opts.storeSecret(QUARK_SECRETS.authCode, value);
    return { ...this.panelState(), message: value ? '授权码已保存' : '授权码已清空' };
  }

  private async login(code: string): Promise<QuarkPanelState> {
    let value = code.trim();
    if (!value) value = this.opts.secret(QUARK_SECRETS.authCode).trim();
    if (!value) return { ...this.panelState(), message: text.unauthorized };
    try {
      const result = await loginWithCode(value, this.runOptions());
      if (result.code !== 0) return { ...this.panelState(), message: text.authFailed(result.msg) };
      // 登录工具本身会顺带取一次用户信息；取不到再单独读一次，让页面立刻有账号信息。
      this.account = toAccount(result);
      if (!this.account.nickname) await this.readAccount();
      return { ...this.panelState(), message: this.account.nickname ? text.loginOk(this.account.nickname) : '已登录' };
    } catch (error) {
      return { ...this.panelState(), message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async logout(): Promise<QuarkPanelState> {
    try {
      const result = await unauthorize(this.runOptions());
      if (result.code !== 0) return { ...this.panelState(), message: result.msg };
      const url = typeof result.data.revokeUrl === 'string' ? result.data.revokeUrl : '';
      return { ...this.panelState(), message: url ? `解绑地址：${url}` : '已解除授权' };
    } catch (error) {
      return { ...this.panelState(), message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async refresh(host?: WorldHost): Promise<void> {
    try {
      const result = await fetchUserInfo(this.runOptions());
      if (result.code !== 0) {
        if (host) {
          await host.pushEvent({
            type: 'quark.authFailed',
            ts: nowIso(this.opts.timezone),
            source: this.id,
            origin: 'external',
            senderKey: this.id,
            text: result.msg,
          });
        }
        return;
      }
      this.account = toAccount(result);
      if (host) {
        await host.pushEvent({
          type: 'quark.account',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          senderKey: this.id,
          text: this.accountText(),
        });
      }
    } catch (error) {
      if (host) {
        await host.pushEvent({
          type: 'quark.authFailed',
          ts: nowIso(this.opts.timezone),
          source: this.id,
          origin: 'external',
          senderKey: this.id,
          text: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 只读一次账号信息，不推事件；读失败时保留上一次的值。 */
  private async readAccount(): Promise<void> {
    try {
      const result = await fetchUserInfo(this.runOptions());
      if (result.code === 0) this.account = toAccount(result);
    } catch {
      // 登录刚成功却读不到账号信息时，页面仍显示已登录；下次刷新再试。
    }
  }

  private accountText(): string {
    const account = this.account;
    if (!account?.nickname) return '账号信息读取失败。';
    const storage = account.capacity !== null
      ? `，网盘空间 ${formatBytes(account.used ?? 0)} / ${formatBytes(account.capacity)}`
      : '';
    return `账号：${account.nickname}，会员状态：${vipLabel(account.vipType)}${storage}。`;
  }

  private runOptions() {
    return {
      cwd: this.opts.botDir,
      timeoutMs: this.opts.cfg.timeoutMs || QUARK_DEFAULTS.timeoutMs,
      sessionId: `${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`,
      sessionInput: '夸克网盘适配器',
    };
  }

  // ---------------------------------------------------------------- 工具

  private async withAccount<T>(fn: (account: QuarkAccount) => T): Promise<T | string> {
    try {
      const result = await fetchUserInfo(this.runOptions());
      if (result.code !== 0) return result.msg;
      this.account = toAccount(result);
      return fn(this.account);
    } catch (error) {
      if (error instanceof QuarkCliError) return error.message;
      return error instanceof Error ? error.message : String(error);
    }
  }

  private getUserInfoTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[0],
      handler: async () => {
        const outcome = await this.withAccount((account) => {
          const storage = account.capacity !== null
            ? `，网盘空间 ${formatBytes(account.used ?? 0)} / ${formatBytes(account.capacity)}`
            : '';
          return `账号：${account.nickname ?? '未知'}，会员状态：${vipLabel(account.vipType)}${storage}。`;
        });
        return outcome;
      },
    };
  }

  private loginTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[1],
      handler: async () => {
        const code = this.opts.secret(QUARK_SECRETS.authCode).trim();
        if (!code) return text.unauthorized;
        try {
          const result = await loginWithCode(code, this.runOptions());
          if (result.code !== 0) return result.msg;
          this.account = toAccount(result);
          return this.accountText();
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    };
  }

  private unauthorizeTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[2],
      handler: async () => {
        try {
          const result = await unauthorize(this.runOptions());
          if (result.code !== 0) return result.msg;
          const url = typeof result.data.revokeUrl === 'string' ? result.data.revokeUrl : '';
          return url ? `解绑地址：${url}` : '已解除授权';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    };
  }
}
