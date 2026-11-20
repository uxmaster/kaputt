// Builds dist/: the browser files minified (widget.js and worker.js bundle their imports),
// each with .gz and .br next to it for nginx gzip_static / brotli_static.
import { rmSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const out = new URL('./dist/', import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ['src/widget.js', 'src/worker.js', 'src/widget.css'].map(file => new URL(file, import.meta.url).pathname),
  outdir: out, minify: true, target: 'browser', naming: '[name].[ext]',
});
if (!result.success) throw new AggregateError(result.logs, 'build failed');
copyFileSync(new URL('./src/hashwx.wasm', import.meta.url), out + 'hashwx.wasm');
for (const file of readdirSync(out)) {
  const data = readFileSync(out + file);
  const gz = gzipSync(data, { level: 9 });
  gz[9] = 3; // gzip header OS byte: zlib writes 19 on macOS and 3 on Linux; fix it so CI can compare builds
  writeFileSync(out + file + '.gz', gz);
  writeFileSync(out + file + '.br', brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
}
