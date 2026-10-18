/**
 * onnxruntime-web 的 package.json exports 没有暴露 types 字段，
 * TS 在 bundle 解析下无法自动找到 `types.d.ts`；这里只声明我们实际使用的 env 子集。
 */
declare module 'onnxruntime-web' {
  export const env: {
    wasm?: {
      wasmPaths?: string | Record<string, string>;
      numThreads?: number;
      proxy?: boolean;
    };
  };
}
