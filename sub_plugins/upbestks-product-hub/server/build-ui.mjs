import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const res = await esbuild.build({
  entryPoints: [path.join(__dirname, 'ui-src', 'app.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  target: ['es2020'],
});

const jsCode = res.outputFiles[0].text;
const tpl = fs.readFileSync(path.join(__dirname, 'ui-src', 'template.html'), 'utf8');
const finalHtml = tpl.replace('/*__APP_BUNDLE__*/', () => jsCode);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const outPath = path.join(__dirname, 'dist', 'app.html');
fs.writeFileSync(outPath, finalHtml, 'utf8');
console.log(`Bundled single-file MCP App HTML: ${outPath} (${(Buffer.byteLength(finalHtml) / 1024).toFixed(1)} KB)`);
