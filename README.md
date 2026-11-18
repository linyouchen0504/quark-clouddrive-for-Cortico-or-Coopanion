# cortico-world-quark

Owner: `src/definition.ts`

把包内的 quarkclouddrive 命令行工具接成 Cortico World。授权码在面板里填，存进部署的 `.env`；账号昵称、网盘空间与会员状态显示在面板与工具回执里。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、label、默认配置段、`create()`、`describe` |
| `src/config.ts` | 配置段、默认值、密钥名、配置组、面板状态形状 |
| `src/cli.ts` | 命令行工具调用与结果解析、账号信息折算、授权码打码 |
| `src/world.ts` | `World` 实现：事件、三个工具、面板数据面、存储项 |
| `src/ENV_PROMPT.md` | 环境提示词模板 |
| `src/webui/client.ts` | 面板：账号信息卡与授权码输入 |
| `skill/` | quarkclouddrive Skill 的命令行工具与文档，随包发布 |

## 用法

```bash
corepack pnpm install
pnpm typecheck && pnpm test
node scripts/build-webui.mjs
```

在 Cortico 仓库根下校验：

```bash
pnpm describe:extension state/packages/quark-world
pnpm check:extension state/packages/quark-world
```

装进实例：WebUI「扩展」页「手动安装」选包目录，重启进程。然后在夸克网盘页填授权码并登录。

## 约束

- 命令行工具以部署目录为工作目录，登录态写在 `<部署>/.quarkclouddrive/`；授权码存 `QUARK_AUTH_CODE`。
- 工具失败时回执原样带 CLI 的 `msg`，不改写。