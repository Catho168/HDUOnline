/** B 站 Wbi 签名纯函数测试：MD5 标准向量、mixin key / w_rid 官方向量、排序与编码规则回归。 */

import { describe, expect, it } from 'vitest';
import { extractWbiKeys, getMixinKey, md5Hex, signWbiParams } from '@/core/bili/wbi';

/** 文档示例 wbi key（bilibili-API-collect docs/misc/sign/wbi.md 的 Rust demo 测试用例） */
const DOCS_IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const DOCS_SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';

describe('md5Hex（RFC 1321）', () => {
  it('标准测试向量', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('中文按 UTF-8 编码（期望值由 node crypto 实际计算）', () => {
    expect(md5Hex('高清网课')).toBe('411889808dbf4a17b60c2d4d87a4cd06');
    expect(md5Hex('网'.repeat(30))).toBe('a89bbf8e7a5f00cf781714677b9f1da2');
  });

  it('填充边界（55/56/64 字节，跨块）', () => {
    expect(md5Hex('a'.repeat(55))).toBe('ef1772b6dff9a122358552954ad0df65');
    expect(md5Hex('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218');
    expect(md5Hex('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367');
  });
});

describe('extractWbiKeys', () => {
  it('从 nav 返回的 wbi_img URL 文件名提取 key', () => {
    expect(
      extractWbiKeys(
        'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad942dc57238b.png',
        'https://i0.hdslb.com/bfs/wbi/4932ca060269963862029f60d8b38017.png',
      ),
    ).toEqual({ imgKey: '7cd084941338484aae1ad942dc57238b', subKey: '4932ca060269963862029f60d8b38017' });
  });

  it('空串与非标准输入回退为空串/整体文件名', () => {
    expect(extractWbiKeys('', '')).toEqual({ imgKey: '', subKey: '' });
    expect(extractWbiKeys('key.png', 'plainname')).toEqual({ imgKey: 'key', subKey: 'plainname' });
  });
});

describe('getMixinKey', () => {
  it('置换重排取前 32 字符（文档官方向量）', () => {
    expect(getMixinKey(DOCS_IMG_KEY, DOCS_SUB_KEY)).toBe('ea1db124af3c7062474693fa704f4ff8');
  });
});

describe('signWbiParams', () => {
  it('文档官方向量：排序 + MD5(query + mixin)（Rust demo 测试用例）', () => {
    const signed = signWbiParams({ foo: '114', bar: '514', zab: '1919810' }, DOCS_IMG_KEY, DOCS_SUB_KEY, 1702204169);
    expect(signed).toMatchObject({ foo: '114', bar: '514', zab: '1919810', wts: 1702204169 });
    expect(signed.w_rid).toBe('8f6f2b5b3d485fe1886cec6a0be8c5d4');
  });

  it('任务规格向量（期望值按本实现以 node 链路计算，锁定排序规则）', () => {
    const signed = signWbiParams(
      { foo: 'one', bar: 'two', zab: 'three' },
      '7cd084941338484aae1ad942dc57238b',
      '4932ca060269963862029f60d8b38017',
      1702204800,
    );
    expect(signed.wts).toBe(1702204800);
    expect(signed.w_rid).toBe('13e7f848d4e9ac9ed5f42a9373018020');
  });

  it('中文/空格编码：encodeURIComponent 语义（%大写、空格为 %20），query 拼接顺序固定', () => {
    const signed = signWbiParams(
      { foo: 'one one four', bar: '五一四', baz: 1919810 },
      DOCS_IMG_KEY,
      DOCS_SUB_KEY,
      1702204800,
    );
    // 期望 query 手工拼出（与文档 Java demo 例子一致的编码行为），签名走已验证的 md5Hex + getMixinKey 链路
    const query = 'bar=%E4%BA%94%E4%B8%80%E5%9B%9B&baz=1919810&foo=one%20one%20four&wts=1702204800';
    expect(signed.w_rid).toBe(md5Hex(query + getMixinKey(DOCS_IMG_KEY, DOCS_SUB_KEY)));
  });

  it('过滤值中的 !\'()* 字符（chr_filter）', () => {
    const signed = signWbiParams({ foo: "a!'()*b" }, DOCS_IMG_KEY, DOCS_SUB_KEY, 1702204800);
    expect(signed.w_rid).toBe(md5Hex('foo=ab&wts=1702204800' + getMixinKey(DOCS_IMG_KEY, DOCS_SUB_KEY)));
  });

  it('纯函数：不修改入参；nowSec 缺省时取当前秒级时间', () => {
    const input = { foo: 'one', bar: 'two' };
    const before = { ...input };
    const signed = signWbiParams(input, DOCS_IMG_KEY, DOCS_SUB_KEY, 1700000000);
    expect(input).toEqual(before);
    expect(signed.wts).toBe(1700000000);
    const now = signWbiParams({ foo: 'x' }, DOCS_IMG_KEY, DOCS_SUB_KEY);
    expect(now.wts).toBe(Math.floor(Date.now() / 1000));
  });
});
