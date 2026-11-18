import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { QUARK_DEFAULTS, type QuarkConfigSection } from './config.ts';
import { QUARK_TOOL_DECLS, QuarkWorld } from './world.ts';

export const QUARK: WorldDefinition<QuarkConfigSection> = {
  id: 'quark',
  label: '夸克网盘',
  defaults: () => ({ ...QUARK_DEFAULTS }),
  create: (ctx) =>
    new QuarkWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      botDir: ctx.botDir,
      secret: (name) => ctx.secret(name),
      storeSecret: (name, value) => ctx.storeSecret(name, value),
    }),
  describe: {
    tools: describeTools(QUARK_TOOL_DECLS, {
      qk_get_user_info: { zh: '读当前账号的昵称、网盘空间与会员状态。', en: 'Reads the current account nickname, storage and membership.' },
      qk_login: { zh: '用部署里保存的授权码登录。', en: 'Signs in with the authorization code stored in the deployment.' },
      qk_unauthorize: { zh: '解除授权并给出解绑地址。', en: 'Revokes the authorization and returns the revoke URL.' },
    }),
    events: [
      { type: 'quark.started', description: { zh: 'World 挂载完成。', en: 'The World was mounted.' } },
      { type: 'quark.account', description: { zh: '账号信息读取完成。', en: 'Account information was read.' }, trigger: 'debounce' },
      { type: 'quark.authFailed', description: { zh: '授权不可用或读取账号信息失败。', en: 'Authorization is unavailable or reading account information failed.' }, trigger: 'flush' },
    ],
  },
};
