import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function bundle() {
  console.log('Bundling xydc-asin-analyzer MCP App UI with esbuild...');
  const entry = path.join(__dirname, 'ui-src', 'app.js');
  const tplPath = path.join(__dirname, 'ui-src', 'template.html');
  const distDir = path.join(__dirname, 'server', 'dist');
  const outPath = path.join(distDir, 'app.html');

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const res = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    minify: true,
    write: false,
    target: ['es2020'],
  });

  const jsCode = res.outputFiles[0].text;
  const tpl = fs.readFileSync(tplPath, 'utf8');
  const finalHtml = tpl.replace('/*__APP_BUNDLE__*/', () => jsCode);

  fs.writeFileSync(outPath, finalHtml, 'utf8');
  console.log(`Successfully built MCP App UI: ${outPath} (${(Buffer.byteLength(finalHtml) / 1024).toFixed(1)} KB)`);
}

bundle().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
