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
  runCli,
  toAccount,
  unauthorize,
  vipLabel,
  type QuarkAccount,
  type QuarkResult,
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
  {
    name: 'qk_confirm',
    description: '回应“每次操作前需确认”的询问：同意则本次操作继续，拒绝则本次不继续。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['confirm', 'reject'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'qk_search',
    description: '按关键词搜索网盘文件，返回文件名、大小、类型、FID 等。可选限定目录 FID、搜索类型、单页大小。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '搜索关键词，最大 50 字符' },
        parentFid: { type: 'string', description: '限定搜索目录 FID，缺省为全盘' },
        searchType: { type: 'string', description: '搜索类型：mix/video/album/doc/audio/dir/package/other/app，缺省 mix' },
        size: { type: 'integer', description: '单页结果数量，范围 1～100，缺省 100' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'qk_browse',
    description: '列出指定目录的直接子项，返回文件列表。可选父目录 FID、单页大小、是否获取全部子项。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parentFid: { type: 'string', description: '父目录 FID，缺省为根目录 0' },
        pageSize: { type: 'integer', description: '单页大小，范围 1～100，缺省 100' },
        all: { type: 'boolean', description: '是否获取全部直接子项，缺省 false' },
      },
    },
  },
  {
    name: 'qk_download',
    description: '下载网盘文件到本地，返回下载任务与本地保存路径。需要文件 FID。',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fid: { type: 'string', description: '要下载的文件 FID' },
        outputDir: { type: 'string', description: '输出目录，缺省 ./downloads' },
        overwrite: { type: 'boolean', description: '同名文件时是否覆盖，缺省自动重命名' },
      },
      required: ['fid'],
    },
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

  /** 有一次操作正在等用户确认。 */
  private awaitingConfirm = false;

  /** 正在等确认的操作说明；没有等待时为空串。 */
  private confirmAction = '';

  /** 用户同意放行的剩余次数；每执行一次操作扣掉一次。 */
  private granted = 0;

  constructor(opts: QuarkWorldOptions) {
    this.opts = opts;
  }

  /** 环境提示词不带占位符；返回空对象即保留模板全文。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  /** 开关开着且没有放行余额时，下一次网盘操作要先问过用户。 */
  private needsConfirm(): boolean {
    return this.opts.cfg.confirmBeforeOp && this.granted <= 0;
  }

  tools(): ToolDef[] {
    return [this.getUserInfoTool(), this.loginTool(), this.unauthorizeTool(), this.confirmTool(), this.searchTool(), this.browseTool(), this.downloadTool()];
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
      pendingConfirm: this.awaitingConfirm,
      confirmAction: this.awaitingConfirm ? this.confirmAction : null,
      confirmBeforeOp: this.opts.cfg.confirmBeforeOp,
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
        this.awaitingConfirm = false;
        this.confirmAction = '';
        this.granted = 0;
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
        case 'confirm':
          return this.answerConfirm(args[0]);
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
      if (this.needsConfirm()) {
        this.awaitingConfirm = true;
        this.confirmAction = '登录';
        this.granted = 0;
        return { ...this.panelState(), message: `${text.confirmBody}（登录）` };
      }
      const result = await loginWithCode(value, this.runOptions());
      if (result.code !== 0) return { ...this.panelState(), message: text.authFailed(result.msg) };
      // 登录工具本身会顺带取一次用户信息；取不到再单独读一次，让页面立刻有账号信息。
      this.account = toAccount(result);
      if (!this.account.nickname) await this.readAccount();
      this.granted -= 1;
      return { ...this.panelState(), message: this.account.nickname ? text.loginOk(this.account.nickname) : '已登录' };
    } catch (error) {
      return { ...this.panelState(), message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async logout(): Promise<QuarkPanelState> {
    try {
      if (this.needsConfirm()) {
        this.awaitingConfirm = true;
        this.confirmAction = '解除授权';
        this.granted = 0;
        return { ...this.panelState(), message: `${text.confirmBody}（解除授权）` };
      }
      const result = await unauthorize(this.runOptions());
      if (result.code !== 0) return { ...this.panelState(), message: result.msg };
      const url = typeof result.data.revokeUrl === 'string' ? result.data.revokeUrl : '';
      this.granted -= 1;
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
      dshHome: this.opts.botDir,
      timeoutMs: this.opts.cfg.timeoutMs || QUARK_DEFAULTS.timeoutMs,
      sessionId: `${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`,
      sessionInput: '夸克网盘适配器',
    };
  }

  // ---------------------------------------------------------------- 工具

  private async withAccount<T>(fn: (account: QuarkAccount) => T): Promise<T | string> {
    // 开关开着时先挂起：回执说明在等确认，并把询问写进事件流，面板据此亮出待确认卡。
    if (this.needsConfirm()) {
      this.awaitingConfirm = true;
      this.confirmAction = '读取账号信息';
      this.granted = 0;
      return `${text.confirmBody}（${this.confirmAction}）`;
    }
    try {
      const result = await fetchUserInfo(this.runOptions());
      // 这次操作已被消费：无论成功还是被 CLI 拒绝，都不该再白拿一次放行。
      this.awaitingConfirm = false;
      this.confirmAction = '';
      this.granted -= 1;
      if (result.code !== 0) return result.msg;
      this.account = toAccount(result);
      return fn(this.account);
    } catch (error) {
      this.awaitingConfirm = false;
      this.confirmAction = '';
      this.granted -= 1;
      if (error instanceof QuarkCliError) return error.message;
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** 用户回执：同意后放行本次操作，拒绝后本次不再继续。 */
  private async answerConfirm(action: unknown): Promise<QuarkPanelState> {
    const answer = action === 'confirm' ? 'confirm' : 'reject';
    if (answer === 'confirm') {
      this.awaitingConfirm = false;
      this.confirmAction = '';
      this.granted = 1;
      return { ...this.panelState(), message: text.confirmed };
    }
    this.awaitingConfirm = false;
    this.confirmAction = '';
    this.granted = 0;
    return { ...this.panelState(), message: text.rejected };
  }

  private getUserInfoTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[0],
      handler: async () => {
        // 开关开着时先挂起：回执说明在等确认，AI 等用户在面板里回应后再调一次。
        if (this.needsConfirm()) {
          this.awaitingConfirm = true;
          this.confirmAction = '读取账号信息';
          return `${text.confirmBody}（${this.confirmAction}）`;
        }
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

  /** 回应待确认的操作；面板的同意/拒绝也走这里。 */
  private confirmTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[3],
      handler: async (args) => {
        return args.action === 'confirm' ? text.confirmed : text.rejected;
      },
    };
  }

  /** 按关键词搜索网盘文件。 */
  private searchTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[4],
      handler: async (args) => {
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
        if (!keyword) return '关键词不能为空';
        const cliArgs: string[] = ['search', '--keyword', keyword];
        if (args.parentFid) cliArgs.push('--parent-fid', String(args.parentFid));
        if (args.searchType) cliArgs.push('--search-type', String(args.searchType));
        if (args.size !== undefined) cliArgs.push('--size', String(args.size));
        try {
          const result = await runCli(cliArgs, this.runOptions());
          if (result.code !== 0) return result.msg;
          return this.formatSearchResult(result);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    };
  }

  /** 列出指定目录的直接子项。 */
  private browseTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[5],
      handler: async (args) => {
        const cliArgs: string[] = ['browse'];
        if (args.parentFid) cliArgs.push('--parent-fid', String(args.parentFid));
        if (args.pageSize !== undefined) cliArgs.push('--page-size', String(args.pageSize));
        if (args.all === true) cliArgs.push('--all');
        try {
          const result = await runCli(cliArgs, this.runOptions());
          if (result.code !== 0) return result.msg;
          return this.formatBrowseResult(result);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    };
  }

  /** 下载网盘文件到本地。 */
  private downloadTool(): ToolDef {
    return {
      ...QUARK_TOOL_DECLS[6],
      handler: async (args) => {
        const fid = typeof args.fid === 'string' ? args.fid.trim() : '';
        if (!fid) return '文件 FID 不能为空';
        const cliArgs: string[] = ['download', '--fid', fid];
        if (args.outputDir) cliArgs.push('--output-dir', String(args.outputDir));
        if (args.overwrite === true) cliArgs.push('--overwrite');
        try {
          const result = await runCli(cliArgs, this.runOptions());
          if (result.code !== 0) return result.msg;
          const data = result.data ?? {};
          const lines: string[] = [];
          lines.push(`文件 FID：${fid}`);
          if (typeof data.filePath === 'string') lines.push(`本地保存：${data.filePath}`);
          if (typeof data.fileName === 'string') lines.push(`文件名：${data.fileName}`);
          if (typeof data.size === 'number') lines.push(`大小：${formatBytes(data.size)}`);
          return lines.join('\n') || '下载任务已提交';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    };
  }

  private formatSearchResult(result: QuarkResult): string {
    const data = result.data ?? {};
    const list = Array.isArray(data.file_list) ? data.file_list : [];
    const total = typeof data.total === 'number' ? data.total : list.length;
    const lines: string[] = [];
    lines.push(`共找到 ${total} 个文件，以上为前 ${Math.min(list.length, 5)} 条预览：`);
    for (const item of list.slice(0, 5)) {
      const name = typeof item.filename === 'string' ? item.filename : '(未知)';
      const size = typeof item.size === 'number' ? formatBytes(item.size) : '';
      const cat = typeof item.category === 'number' ? this.categoryLabel(item.category) : '';
      lines.push(`- ${name}${size ? ` (${size})` : ''}${cat ? ` · ${cat}` : ''}`);
    }
    return lines.join('\n');
  }

  private formatBrowseResult(result: QuarkResult): string {
    const data = result.data ?? {};
    const list = Array.isArray(data.file_list) ? data.file_list : [];
    const lines: string[] = [];
    lines.push(`目录下共有 ${list.length} 个直接子项：`);
    for (const item of list.slice(0, 10)) {
      const name = typeof item.filename === 'string' ? item.filename : '(未知)';
      const size = typeof item.size === 'number' ? formatBytes(item.size) : '';
      const isFolder = typeof item.file_type === 'string' ? item.file_type === '0' : false;
      lines.push(`- ${name}${isFolder ? ' /' : ''}${size && !isFolder ? ` (${size})` : ''}`);
    }
    return lines.join('\n');
  }

  private categoryLabel(c: number): string {
    switch (c) {
      case 0: return '文件夹';
      case 1: return '视频';
      case 2: return '音频';
      case 3: return '图片';
      case 4: return '文档';
      case 5: return '种子';
      case 6: return '其他';
      case 7: return '压缩包';
      case 8: return '应用';
      default: return '未知';
    }
  }
}
