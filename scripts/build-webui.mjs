/**
 * 浏览器端面板产物：把 src/webui/client.ts 打成 dist/webui.js。
 * 浏览器侧只 import type，运行时代码全在包内。
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await esbuild.build({
  entryPoints: [join(root, 'src/webui/client.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  outfile: join(root, 'dist/webui.js'),
  logLevel: 'info',
});
