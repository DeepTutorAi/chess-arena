// Asset hygiene: unreferenced images were being shipped (3.5 MB) and the ones
// in use were far larger than their display size (banners 1 MB for a 120x80
// thumbnail). Keep both from creeping back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const assetsDir = join(root, 'public', 'assets');
const RASTER = /\.(jpe?g|png|webp|avif|gif)$/iu;
const MAX_BYTES = 200 * 1024;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const images = walk(assetsDir).filter((file) => RASTER.test(file));
const sourceText = [
  ...readdirSync(join(root, 'src')).filter((f) => /\.(js|css)$/u.test(f)).map((f) => readFileSync(join(root, 'src', f), 'utf8')),
  readFileSync(join(root, 'index.html'), 'utf8'),
  readFileSync(join(root, 'public', 'manifest.webmanifest'), 'utf8'),
].join('\n');

test('there are raster images to check (guard against a broken glob)', () => {
  assert.ok(images.length >= 8, `found ${images.length}`);
});

test('every shipped image is referenced by the app', () => {
  const orphans = images.filter((file) => !sourceText.includes(basename(file)));
  assert.deepEqual(orphans.map((f) => relative(root, f)), [], 'unreferenced images are shipped to production');
});

test('no shipped image is heavier than 200 KB', () => {
  const heavy = images
    .map((file) => [relative(root, file), statSync(file).size])
    .filter(([, size]) => size > MAX_BYTES);
  assert.deepEqual(heavy, [], 'resize/compress these (WebP at 2x display size)');
});

test('the home background is bundled by Vite (no ../assets path that only works by accident)', () => {
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /url\(['"]?\.\.\/assets\//u);
  assert.match(css, /url\('\.\/img\/park-bg\.webp'\)/u);
});
