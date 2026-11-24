/**
 * B 站 Web API Wbi 签名纯函数模块（w_rid + wts）。
 *
 * 算法出处：社区逆向文档 bilibili-API-collect「WBI 签名」
 * （https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/wbi.md）：
 *  1. nav 接口返回 wbi_img.img_url / sub_url，截取文件名得 img_key / sub_key；
 *  2. img_key + sub_key 按固定置换表重排并取前 32 字符得 mixin_key；
 *  3. 请求参数追加 wts（秒级 Unix 时间戳）后按键名升序排序，值过滤 !'()* 字符，
 *     再按 encodeURIComponent 语义（十六进制大写、空格为 %20）编码拼接 query；
 *  4. query + mixin_key 的 MD5 即 w_rid。
 *
 * 本模块只含纯函数、无副作用，可独立单测；MD5 为 RFC 1321 标准算法的纯 TS 实现
 * （项目不引入 npm 依赖，输入按 UTF-8 编码）。
 */

/** wbi 重排映射表（bilibili-API-collect docs/misc/sign/wbi.md，长度 64） */
const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 参与签名的值需要过滤掉的字符（社区文档 demo 中的 chr_filter） */
const WBI_VALUE_FILTER = /[!'()*]/g;

/** 截取 URL 文件名并去掉扩展名：…/wbi/7cd08494….png → 7cd08494…；空输入返回空串 */
function fileNameKey(url: string): string {
  if (!url) return '';
  const slash = url.lastIndexOf('/');
  const name = slash >= 0 ? url.slice(slash + 1) : url;
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export interface WbiKeys {
  imgKey: string;
  subKey: string;
}

/** 从 nav 接口返回的 img_url / sub_url 文件名提取 wbi key */
export function extractWbiKeys(imgUrl: string, subUrl: string): WbiKeys {
  return { imgKey: fileNameKey(imgUrl), subKey: fileNameKey(subUrl) };
}

/** img_key + sub_key 按置换表重排，取前 32 字符得 mixin_key */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let out = '';
  for (const index of MIXIN_KEY_ENC_TAB) {
    out += raw[index] ?? '';
  }
  return out.slice(0, 32);
}

/**
 * 计算带 wbi 签名的请求参数：在入参基础上追加 wts 与 w_rid 后返回（不修改入参）。
 * nowSec 供测试注入固定时间戳；缺省取当前秒级 Unix 时间。
 */
export function signWbiParams(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  nowSec?: number,
): Record<string, string | number> {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = nowSec ?? Math.floor(Date.now() / 1000);
  const merged: Record<string, string | number> = { ...params, wts };
  // 按键名升序排序，值过滤 !'()* 后编码拼接（编码行为与 encodeURIComponent 一致）
  const query = Object.keys(merged)
    .sort()
    .map((key) => {
      const value = String(merged[key]).replace(WBI_VALUE_FILTER, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return { ...merged, w_rid: md5Hex(query + mixinKey) };
}

// ───────────────────────── MD5（RFC 1321） ─────────────────────────

/** 每轮循环移位数（RFC 1321 §3.4，四轮各 16 步） */
const MD5_SHIFTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** 常量表 T[i] = floor(|sin(i+1)| × 2³²)（RFC 1321 §3.3，模块加载期确定性计算） */
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** 32 位字按字节反转（摘要输出为小端字节序） */
function byteSwap32(value: number): number {
  return (
    (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | (value >>> 24)) >>> 0
  );
}

function toHex32(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/** MD5 压缩函数：对一块（16 个小端 32 位字）执行 64 步循环（RFC 1321 §3.4） */
function md5CompressBlock(words: Uint32Array, state: Uint32Array): void {
  let a = state[0] as number;
  let b = state[1] as number;
  let c = state[2] as number;
  let d = state[3] as number;
  for (let i = 0; i < 64; i += 1) {
    let f: number;
    let g: number;
    if (i < 16) {
      f = (b & c) | (~b & d); // F(b,c,d) = (b ∧ c) ∨ (¬b ∧ d)
      g = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c); // G(b,c,d) = (d ∧ b) ∨ (¬d ∧ c)
      g = (5 * i + 1) % 16;
    } else if (i < 48) {
      f = b ^ c ^ d; // H(b,c,d) = b ⊕ c ⊕ d
      g = (3 * i + 5) % 16;
    } else {
      f = c ^ (b | ~d); // I(b,c,d) = c ⊕ (b ∨ ¬d)
      g = (7 * i) % 16;
    }
    const sum = (f + a + (MD5_K[i] as number) + (words[g] as number)) | 0;
    a = d;
    d = c;
    c = b;
    b = (b + rotl32(sum, MD5_SHIFTS[i] as number)) | 0;
  }
  state[0] = ((state[0] as number) + a) | 0;
  state[1] = ((state[1] as number) + b) | 0;
  state[2] = ((state[2] as number) + c) | 0;
  state[3] = ((state[3] as number) + d) | 0;
}

/**
 * MD5 摘要（RFC 1321 标准算法，输入按 UTF-8 编码，返回 32 位小写十六进制）。
 * 注：MD5 规范编号为 RFC 1321（社区文档常误写为 1329）。
 */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  // 填充：追加 0x80 与零到 (len + 9) 向上取整至 64 字节倍数，末 8 字节为比特长度（小端）
  const paddedLen = (Math.floor((len + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = len * 8;
  view.setUint32(paddedLen - 8, bits >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bits / 2 ** 32), true);

  const state = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);
  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let j = 0; j < 16; j += 1) {
      words[j] = view.getUint32(offset + j * 4, true);
    }
    md5CompressBlock(words, state);
  }
  let out = '';
  for (const word of state) {
    out += toHex32(byteSwap32(word));
  }
  return out;
}
