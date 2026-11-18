import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

/** 一次 CLI 调用的上限；登录要等服务端换 token，给得比常规操作宽。 */
export const CLI_TIMEOUT_MS = 120_000;

/** 授权码存在部署 .env 里的变量名；core 不认识这个名字。 */
export const QUARK_SECRETS = {
  authCode: 'QUARK_AUTH_CODE',
} as const;

/** 面板 `state` 的返回形状；授权码只给打码后的样子。 */
export interface QuarkPanelState {
  loggedIn: boolean;
  nickname: string | null;
  vipType: string | null;
  /** 已用字节；接口没给时为 null。 */
  used: number | null;
  /** 总容量字节；接口没给时为 null。 */
  capacity: number | null;
  /** 授权码是否已填。 */
  authCodeSet: boolean;
  /** 打码后的授权码。 */
  maskedAuthCode: string | null;
  /** 上一次操作的说明；没有则为 null。 */
  message: string | null;
}

/** config.json 的 `worlds.quark` 节。 */
export interface QuarkConfigSection {
  enabled: boolean;
  /** CLI 一次调用的超时毫秒数。 */
  timeoutMs: number;
}

export const QUARK_DEFAULTS = {
  enabled: false,
  timeoutMs: CLI_TIMEOUT_MS,
} as const;

/** 中文文案。界面是别的语言时由 strings.<语言>.ts 覆盖。 */
export const text = {
  moduleLabel: '夸克网盘',
  panelTitle: '夸克网盘',
  panelDescription: '填授权码登录，查看账号昵称、网盘空间与会员状态。',
  accountTitle: '账号',
  authTitle: '授权',
  authCode: '授权码',
  authCodeDesc: '在夸克网盘授权页完成后，从跳转地址里复制的 code。',
  authCodePlaceholder: '粘贴授权码',
  save: '保存',
  login: '登录',
  logout: '解除授权',
  refresh: '刷新',
  loggedIn: '已登录',
  loggedOut: '未登录',
  nickname: '昵称',
  vipType: '会员状态',
  storage: '网盘空间',
  usedOf: (used: string, total: string) => `已用 ${used} / 共 ${total}`,
  unknown: '未知',
  normal: '普通用户',
  svip: '超级会员',
  svipPlus: '超级会员+',
  keyUnset: '未填授权码',
  keySet: '已填授权码',
  authFailed: (msg: string) => `授权失败：${msg}`,
  loginOk: (nickname: string) => `已登录：${nickname}`,
  unknownPanel: (panel: string) => `未知面板：${panel}`,
  unknownMethod: (method: string) => `未知方法：${method}`,
  unauthorized: '当前未授权或授权已过期，请填授权码后重试。',
} as const;

/** 本 World 声明的可调项：只暴露 CLI 超时，其余走密钥与面板。 */
export function quarkConfigGroup(language: Language): ConfigGroup {
  return {
    id: 'world:quark',
    owner: 'world:quark',
    schema: {
      type: 'object',
      title: text.moduleLabel,
      description: '授权码在面板里填，存在部署的 .env；这里只调 CLI 超时。',
      properties: {
        'worlds.quark.timeoutMs': {
          type: 'integer',
          title: 'CLI 超时',
          minimum: 10_000,
          maximum: 300_000,
          multipleOf: 1000,
          'x-scale': 1000,
          'x-suffix': 's',
          'x-hot': true,
          description: '调用夸克网盘命令行工具的上限。',
        },
      },
    },
  };
}
