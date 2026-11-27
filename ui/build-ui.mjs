import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 屏蔽 xlsx-js-style 内部对 Node 内置模块的条件 require，避免浏览器抛 Dynamic require 异常
const nodeStubPlugin = {
  name: 'node-builtin-stub',
  setup(build) {
    build.onResolve({ filter: /^(fs|path|crypto|stream|zlib|util|buffer)$/ }, (args) => ({
      path: args.path,
      namespace: 'node-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
};

const res = await esbuild.build({
  entryPoints: [path.join(__dirname, 'src', 'app.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  write: false,
  target: ['es2020'],
  jsx: 'automatic',
  plugins: [nodeStubPlugin],
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'window',
  },
});

const jsCode = res.outputFiles[0].text;
const tpl = fs.readFileSync(path.join(__dirname, 'src', 'template.html'), 'utf8');
const finalHtml = tpl.replace('/*__APP_BUNDLE__*/', () => jsCode);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const outPath = path.join(__dirname, 'dist', 'app.html');
fs.writeFileSync(outPath, finalHtml, 'utf8');
console.log(`Bundled single-file MCP App HTML: ${outPath} (${(Buffer.byteLength(finalHtml) / 1024).toFixed(1)} KB)`);
