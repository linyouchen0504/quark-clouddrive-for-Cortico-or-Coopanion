/**
 * 调用包内 quarkclouddrive Skill 的命令行工具，解析它的一行 JSON 结果。
 * 工具输出 NDJSON：过程行与一条 type 为 result 的终态行。
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CLI_PATH = fileURLToPath(new URL('../skill/scripts/quark-drive.cjs', import.meta.url));

export interface QuarkAccount {
  nickname: string | null;
  /** 服务端返回的会员类型原值。 */
  vipType: string | null;
  used: number | null;
  capacity: number | null;
}

export interface QuarkResult {
  code: number;
  msg: string;
  data: Record<string, unknown>;
  notice: { text?: string } | null;
}

/** 命令行工具缺失或不可执行时抛出。 */
export class QuarkCliError extends Error {}

export interface RunOptions {
  /** 工具的工作目录；登录态写在它下面的 `.quarkclouddrive/`。 */
  cwd: string;
  timeoutMs: number;
  /** 会话标识，同一对话内复用。 */
  sessionId: string;
  /** 触发本次调用的用户原话。 */
  sessionInput: string;
  /** 给工具的 DSH_HOME；工具把配置写到 `<DSH_HOME>/skills/quarkclouddrive/`。 */
  dshHome: string;
}

/**
 * 命令行工具用环境变量识别自己跑在哪种 agent 里，识别不到就抛「无法识别当前 Agent 环境」。
 * 部署环境通常没有这些变量，所以显式补上 `DSH_HOME` 指回部署目录：
 * 工具按它定位配置，登录态跟着部署走。
 */
export function childEnv(dshHome: string): NodeJS.ProcessEnv {
  return { ...process.env, DSH_HOME: dshHome };
}

const AUTH_CODE_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** 解析 stdout 里最后一条 type 为 result 的 JSON 行。 */
export function parseResult(stdout: string): QuarkResult | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type !== 'result') continue;
      return {
        code: typeof parsed.code === 'number' ? parsed.code : 0,
        msg: typeof parsed.msg === 'string' ? parsed.msg : '',
        data: (parsed.data && typeof parsed.data === 'object' ? parsed.data : {}) as Record<string, unknown>,
        notice: (parsed.notice && typeof parsed.notice === 'object' ? parsed.notice : null) as QuarkResult['notice'],
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 运行一条命令；退出码非 0 时仍先读终态行，工具用非零退出码表示失败，
 * 但它写在 stdout 的 `msg` 才是给用户看的话。
 */
export async function runCli(args: string[], opts: RunOptions): Promise<QuarkResult> {
  if (!existsSync(CLI_PATH)) throw new QuarkCliError(`command line tool is missing: ${CLI_PATH}`);
  const common = ['--session-input', opts.sessionInput, '--session-id', opts.sessionId];
  const settled = await execFileAsync(
    process.execPath,
    [CLI_PATH, ...args, ...common],
    { cwd: opts.cwd, env: childEnv(opts.dshHome), timeout: Math.max(1000, Math.floor(opts.timeoutMs)), maxBuffer: 8 * 1024 * 1024 },
  ).catch((error) => {
    if (error && typeof error === 'object' && 'stdout' in error) return error as { stdout?: string };
    throw error;
  });
  const result = parseResult(String(settled.stdout ?? ''));
  if (!result) {
    const detail = settled instanceof Error ? settled.message : String(settled);
    throw new QuarkCliError(`command failed: ${detail}`);
  }
  return result;
}

/** 授权码只允许无空白、无 shell 元字符的紧凑串；不合形状时不调用工具。 */
export function validateAuthCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed || /\s/.test(trimmed) || !AUTH_CODE_PATTERN.test(trimmed)) {
    throw new QuarkCliError('授权码形状不对：应为不含空白的紧凑字符串');
  }
  return trimmed;
}

/** 读账号信息。 */
export async function fetchUserInfo(opts: RunOptions): Promise<QuarkResult> {
  return runCli(['get-user-info'], opts);
}

/** 用授权码登录。 */
export function loginWithCode(code: string, opts: RunOptions): Promise<QuarkResult> {
  return runCli(['login', '--token', validateAuthCode(code)], opts);
}

/** 解除授权，返回解绑地址。 */
export function unauthorize(opts: RunOptions): Promise<QuarkResult> {
  return runCli(['unauthorize'], opts);
}

/** 会员类型换成用户读得懂的中文；认不出的原样返回。 */
export function vipLabel(vipType: string | null | undefined): string {
  if (!vipType) return '未知';
  const value = vipType.trim().toUpperCase();
  if (value.includes('SVIP_PLUS') || value.includes('SVIP+')) return '超级会员+';
  if (value.includes('SVIP')) return '超级会员';
  if (value === 'NORMAL' || value === 'NONE') return '普通用户';
  return vipType;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 把 get-user-info 的结果折成账号信息；容量缺失时对应字段为 null。 */
export function toAccount(result: QuarkResult): QuarkAccount {
  const data = result.data ?? {};
  const vipInfo = (data.vipInfo && typeof data.vipInfo === 'object' ? data.vipInfo : {}) as Record<string, unknown>;
  const userInfo = (data.userInfo && typeof data.userInfo === 'object' ? data.userInfo : {}) as Record<string, unknown>;
  return {
    nickname: typeof userInfo.nickname === 'string' && userInfo.nickname.trim() ? userInfo.nickname.trim() : null,
    vipType: typeof vipInfo.vipType === 'string' && vipInfo.vipType.trim() ? vipInfo.vipType.trim() : null,
    used: typeof vipInfo.used === 'number' ? vipInfo.used : null,
    capacity: typeof vipInfo.capacity === 'number' ? vipInfo.capacity : null,
  };
}

/** 授权码打码：前 4 位与后 2 位。 */
export function maskAuthCode(code: string): string {
  if (code.length <= 8) return `${code.slice(0, 2)}…`;
  return `${code.slice(0, 4)}…${code.slice(-2)}`;
}

export { bytes as formatBytes };
