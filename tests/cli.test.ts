/** CLI 结果解析与账号折算，不联网、不碰命令行工具。 */
import { describe, expect, it } from 'vitest';
import { formatBytes, maskAuthCode, parseResult, toAccount, validateAuthCode, vipLabel, type QuarkResult } from '../src/cli.ts';

const resultLine = (body: Record<string, unknown>): string => `${JSON.stringify({ type: 'progress' })}\n${JSON.stringify({ type: 'result', ...body })}\n`;

describe('parseResult', () => {
  it('取最后一条终态行，忽略过程行', () => {
    const stdout = resultLine({ code: 0, msg: '成功', action: 'get-user-info', data: {} });
    expect(parseResult(stdout)).toMatchObject({ code: 0, msg: '成功' });
  });

  it('带上 notice 与 data 原样取出', () => {
    const stdout = resultLine({ code: -102, msg: '授权码已过期', data: { a: 1 }, notice: { kind: 'skill_updated', text: '升级文案' } });
    expect(parseResult(stdout)).toEqual({
      code: -102,
      msg: '授权码已过期',
      data: { a: 1 },
      notice: { kind: 'skill_updated', text: '升级文案' },
    });
  });

  it('没有终态行时返回 null', () => {
    expect(parseResult('{"type":"progress"}\n')).toBeNull();
  });
});

describe('validateAuthCode', () => {
  it('拒掉带空白或 shell 元字符的授权码', () => {
    expect(() => validateAuthCode('abc def')).toThrow();
    expect(() => validateAuthCode('a;rm -rf')).toThrow();
    expect(validateAuthCode('  Abc-123_456.~  ')).toBe('Abc-123_456.~');
  });
});

describe('toAccount', () => {
  it('折出昵称、会员与容量', () => {
    const result: QuarkResult = {
      code: 0,
      msg: '成功',
      data: {
        vipInfo: { vipType: 'SVIP', used: 1024, capacity: 2048 },
        userInfo: { nickname: '小明' },
      },
      notice: null,
    };
    expect(toAccount(result)).toEqual({ nickname: '小明', vipType: 'SVIP', used: 1024, capacity: 2048 });
  });

  it('缺字段时为 null，不补造', () => {
    expect(toAccount({ code: 0, msg: '成功', data: {}, notice: null }))
      .toEqual({ nickname: null, vipType: null, used: null, capacity: null });
  });
});

describe('vipLabel', () => {
  it('换成用户读得懂的中文', () => {
    expect(vipLabel('NORMAL')).toBe('普通用户');
    expect(vipLabel('SVIP')).toBe('超级会员');
    expect(vipLabel('SVIP_PLUS')).toBe('超级会员+');
    expect(vipLabel('会员版')).toBe('会员版');
  });
});

describe('maskAuthCode / formatBytes', () => {
  it('授权码只露头尾', () => {
    expect(maskAuthCode('abcdef123456')).toBe('abcd…56');
    expect(maskAuthCode('abc')).toBe('ab…');
  });

  it('容量换算成可读单位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
