/**
 * 夸克网盘面板：账号信息、授权码，以及「每次操作前需确认」的开关与待确认卡。
 * 授权码经服务端 `saveCode` 写进部署 .env，浏览器只拿得到打码后的样子。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { QuarkPanelState } from '../config.ts';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function bytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function vip(v: string): string {
  const value = v.trim().toUpperCase();
  if (value.includes('SVIP+')) return '超级会员+';
  if (value.includes('SVIP')) return '超级会员';
  if (value === 'NORMAL' || value === 'NONE') return '普通用户';
  return v;
}

const accountPanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: '账号', desc: '昵称、网盘空间与会员状态。' });
    const status = ui.h('span', 'mono', '未登录');
    const nickname = ui.h('span', 'mono', '—');
    const member = ui.h('span', 'mono', '—');
    const storage = ui.h('span', 'mono', '—');
    sheet.body.append(
      ui.kv([
        { k: '状态', v: status },
        { k: '昵称', v: nickname },
        { k: '会员状态', v: member },
        { k: '网盘空间', v: storage },
      ]),
    );

    // 每次操作前需确认：写在账号页，因为它是这个 World 的总开关。
    const toggle = ui.checkbox('每次操作前需确认', {
      checked: true,
      onChange: (checked) => { void saveToggle(checked); },
      title: '打开后 AI 要动网盘文件会先在这里等你点同意或拒绝。',
    });
    sheet.body.append(ui.actions());
    sheet.body.lastElementChild?.append(toggle.el);

    const refresh = ui.button('刷新', { size: 'sm', onClick: () => void refreshNow() });
    sheet.body.lastElementChild?.append(refresh);
    root.append(sheet.el);

    let state: QuarkPanelState | null = null;

    function render(next: QuarkPanelState): void {
      state = next;
      status.textContent = next.loggedIn ? '已登录' : '未登录';
      nickname.textContent = next.loggedIn ? next.nickname ?? '未知' : '—';
      member.textContent = next.vipType ? vip(next.vipType) : '—';
      storage.textContent = next.capacity !== null
        ? `已用 ${bytes(next.used)} / 共 ${bytes(next.capacity)}`
        : '未取到';
      toggle.setChecked(next.confirmBeforeOp);
    }

    async function saveToggle(checked: boolean): Promise<void> {
      try {
        await ctx.setConfig('world:quark', { 'worlds.quark.confirmBeforeOp': checked });
        ui.toast(checked ? '已打开操作前确认' : '已关闭操作前确认');
      } catch (err) {
        ui.toast(errText(err), 'bad');
        if (state) toggle.setChecked(state.confirmBeforeOp);
      }
    }

    async function refreshNow(): Promise<void> {
      try {
        render(await ctx.invoke<QuarkPanelState>('state'));
        await ctx.refresh();
      } catch (err) {
        ui.toast(errText(err), 'bad');
      }
    }

    try {
      render(await ctx.invoke<QuarkPanelState>('state'));
    } catch (err) {
      ui.toast(errText(err), 'bad');
    }
  },
};

const authPanel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const sheet = ui.sheet({ title: '授权', desc: '填授权码后点登录；已保存的授权码只显示打码后的样子。' });

    const masked = ui.h('div', 'msgline', '尚未保存授权码');
    const code = ui.input({
      type: 'password',
      cls: 'mono grow',
      placeholder: '粘贴授权码',
      onCommit: () => void call('saveCode', [code.value]),
    });
    const save = ui.button('保存授权码', { size: 'sm', variant: 'primary' });
    save.addEventListener('click', () => { void call('saveCode', [code.value]); code.value = ''; });

    const row = ui.rowbar();
    row.append(code, save);

    const msg = ui.msgline();
    msg.hidden = true;
    sheet.body.append(masked, row, msg);

    // 待确认卡：AI 发起操作后亮出来，用户点同意或拒绝。
    const pending = ui.h('div', 'msgline', '');
    pending.hidden = true;
    const yes = ui.button('同意', { size: 'sm', variant: 'primary', onClick: () => void answer('confirm') });
    const no = ui.button('拒绝', { size: 'sm', variant: 'danger', onClick: () => void answer('reject') });
    const bar = ui.actions();
    bar.append(yes, no);
    bar.hidden = true;
    sheet.body.append(pending, bar);

    const login = ui.button('登录', { size: 'sm' });
    login.addEventListener('click', () => { void call('login', []); });
    const logout = ui.button('解除授权', { size: 'sm', variant: 'danger' });
    logout.addEventListener('click', () => { void call('logout', []); });

    sheet.body.append(ui.actions());
    sheet.body.lastElementChild?.append(login, logout);
    root.append(sheet.el);

    function showMessage(text: string): void {
      msg.textContent = text;
      msg.hidden = !text;
    }

    function renderPending(next: QuarkPanelState): void {
      pending.textContent = next.pendingConfirm
        ? `AI 正在等确认：${next.confirmAction ?? '操作'}`
        : '';
      pending.hidden = !next.pendingConfirm;
      bar.hidden = !next.pendingConfirm;
    }

    async function answer(action: 'confirm' | 'reject'): Promise<void> {
      try {
        const next = await ctx.invoke<QuarkPanelState>('confirm', [action]);
        showMessage(next.message ?? '');
        renderPending(next);
        await ctx.refresh();
      } catch (err) {
        showMessage(errText(err));
      }
    }

    async function call(method: string, args: unknown[] = []): Promise<void> {
      try {
        const next = await ctx.invoke<QuarkPanelState>(method, args);
        showMessage(next.message ?? '');
        renderPending(next);
        masked.textContent = next.maskedAuthCode
          ? `已保存：${next.maskedAuthCode}`
          : '尚未保存授权码';
        await ctx.refresh();
      } catch (err) {
        showMessage(errText(err));
      }
    }

    await call('state');
  },
};

const bundle: WebUiClientBundle = {
  // 键是局部 panel id,与服务端 `webUi().panels[].id` 一一对应。
  panels: { account: accountPanel, auth: authPanel },
};

export default bundle;
