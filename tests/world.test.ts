/** World 构造、工具名、面板数据面与事件投递，用假宿主，不联网。 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUARK } from '../src/definition.ts';
import { QUARK_TOOL_DECLS } from '../src/world.ts';
import type { World } from 'cortico/core/types.ts';
import type { QuarkPanelState } from '../src/config.ts';

class Host {
  events: Array<Record<string, unknown>> = [];
  async pushEvent(e: Record<string, unknown>): Promise<void> {
    this.events.push(e);
  }
}

function makeWorld(secret = ''): { world: World; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quark-world-'));
  const world = QUARK.create({
    id: 'quark',
    cfg: { ...QUARK.defaults(), enabled: true },
    timezone: 'Asia/Shanghai',
    botName: '测试',
    botDir: dir,
    packageDir: dir,
    dataDir: dir,
    repoRoot: dir,
    secret: () => secret,
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  });
  return { world, dir };
}

describe('definition', () => {
  it('默认关闭，工具名全部在自描述里', () => {
    const defaults = QUARK.defaults();
    expect(defaults.enabled).toBe(false);
    const declared = new Set(QUARK.describe!.tools.map((t) => t.name));
    for (const tool of QUARK_TOOL_DECLS) expect(declared.has(tool.name)).toBe(true);
  });
});

describe('world', () => {
  it('面板声明两块，状态灯随登录态', () => {
    const { world } = makeWorld();
    const decl = world.webUi!('zh');
    expect(decl.panels?.map((p) => p.id)).toEqual(['account', 'auth']);
    expect(decl.lamps?.[0]?.state).toBe('offline');
  });

  it('挂载时投递 quark.started', async () => {
    const { world, dir } = makeWorld();
    const host = new Host();
    await world.start(host as never);
    expect(host.events[0]).toMatchObject({ type: 'quark.started', source: 'quark', origin: 'internal' });
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('没授权码时登录如实说明，不吞话', async () => {
    const { world, dir } = makeWorld();
    const auth = await world.webUi!('zh').invoke!('auth', 'login', []);
    expect(auth).toMatchObject({ message: expect.stringContaining('未授权') });
    rmSync(dir, { recursive: true, force: true });
  });

  it('保存授权码写进部署 .env，页面只看到打码', async () => {
    const { world, dir } = makeWorld();
    let stored = '';
    const withStore = QUARK.create({
      id: 'quark',
      cfg: { ...QUARK.defaults(), enabled: true },
      timezone: 'Asia/Shanghai',
      botName: '测试',
      botDir: dir,
      packageDir: dir,
      dataDir: dir,
      repoRoot: dir,
      secret: () => stored,
      storeSecret: (_name, value) => { stored = value; },
      persist: () => {},
      restart: async () => {},
    });
    const state = await withStore.webUi!('zh').invoke!('auth', 'saveCode', ['abcdef123456']);
    expect(stored).toBe('abcdef123456');
    expect(state).toMatchObject({ authCodeSet: true, maskedAuthCode: 'abcd…56' });
    expect(JSON.stringify(state)).not.toContain('abcdef123456');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('每次操作前需确认', () => {
  it('开关打开时，操作先挂起并说明在等确认', async () => {
    const { world, dir } = makeWorld();
    const ui = world.webUi!('zh');
    const invoke = ui.invoke!;
    void ui;
    const state = await invoke('account', 'state', []) as QuarkPanelState;
    expect(state.confirmBeforeOp).toBe(true);
    // 同意放行一次后，待确认卡应消失
    const answer = await invoke('auth', 'confirm', ['confirm']) as QuarkPanelState;
    expect(answer.message).toContain('可以继续');
    expect(answer.pendingConfirm).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('开关关掉时不挂起', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quark-confirm-'));
    const world = QUARK.create({
      id: 'quark',
      cfg: { ...QUARK.defaults(), enabled: true, confirmBeforeOp: false },
      timezone: 'Asia/Shanghai',
      botName: '测试',
      botDir: dir,
      packageDir: dir,
      dataDir: dir,
      repoRoot: dir,
      secret: () => '',
      storeSecret: () => {},
      persist: () => {},
      restart: async () => {},
    });
    const invoke = world.webUi!('zh').invoke!;
    const state = await invoke('account', 'state', []) as QuarkPanelState;
    expect(state.confirmBeforeOp).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
