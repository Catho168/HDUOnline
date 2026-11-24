/**
 * scripts/size-check.mjs 的类型声明（第 246 轮巡检）：供 tests/unit/size-check.test.ts
 * 以类型安全方式导入纯函数；脚本本体为可独立运行的 .mjs（CLI 参数见脚本头注释）。
 */
export declare const DEFAULT_TOL_ABS: number;
export declare const DEFAULT_TOL_PCT: number;
export declare function listJsFiles(outDir: string): Promise<string[]>;
export declare function parseChunkRefs(code: string): { eager: string[]; dynamic: string[] };
export declare function formatBytes(bytes: number): string;
export interface SizeIssue {
  entry: string;
  kind: 'growth' | 'new' | 'shrink';
  baseline: number | null;
  current: number;
  delta: number;
  deltaPct: number | null;
}
export declare function compareSizes(
  current: Record<string, number>,
  baseline: Record<string, number>,
  tolPct?: number,
  tolAbs?: number,
): SizeIssue[];
