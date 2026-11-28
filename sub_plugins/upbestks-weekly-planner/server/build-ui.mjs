import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const esbuild = await import(pathToFileURL('C:/Users/admin/.gemini/config/plugins/upbestks-ads-hub/server/node_modules/esbuild/lib/main.js').href);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const res = await esbuild.build({
  entryPoints: [path.join(__dirname, 'ui-src', 'app.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  target: ['es2020'],
  nodePaths: ['C:/Users/admin/.gemini/config/plugins/upbestks-ads-hub/server/node_modules'],
});

const jsCode = res.outputFiles[0].text;
const tpl = fs.readFileSync(path.join(__dirname, 'ui-src', 'template.html'), 'utf8');
const finalHtml = tpl.replace('/*__APP_BUNDLE__*/', () => jsCode);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const outPath = path.join(__dirname, 'dist', 'app.html');
fs.writeFileSync(outPath, finalHtml, 'utf8');
console.log(`Bundled: ${outPath} (${(Buffer.byteLength(finalHtml) / 1024).toFixed(1)} KB)`);
