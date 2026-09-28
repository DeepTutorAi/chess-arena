// PWA assets (roadmap.md D1): the manifest must be valid and installable, and
// the hand-rolled service worker must NEVER cache the online/lobby API while
// keeping the versioned-cache cleanup intact.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('manifest is valid JSON and installable (name, icons, standalone)', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.name?.length >= 3);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url !== undefined);
  for (const icon of manifest.icons) {
    assert.ok(icon.src && icon.type && icon.sizes);
    // referenced assets must exist
    await readFile(join(root, 'public', icon.src.replace(/^\.\//, '')));
  }
});

test('index.html links the manifest and a theme color', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /rel="manifest"/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /name="theme-color"/);
});

test('service worker never caches the online API and cleans old caches', async () => {
  const sw = await readFile(join(root, 'public', 'sw.js'), 'utf8');
  assert.match(sw, /CACHE_VERSION/, 'versioned cache name');
  assert.match(sw, /isApiPath/, 'api requests are excluded via a dedicated guard');
  assert.match(sw, /\$\{SCOPE_PATH\}api\//, 'the api path pattern is scope-aware');
  assert.match(sw, /skipWaiting/, 'new workers activate immediately');
  assert.match(sw, /clients\.claim/, 'the worker takes control without a second reload');
  assert.match(sw, /caches\.delete\(/, 'old cache versions are cleaned on activate');
  // The api guard must short-circuit BEFORE any cache read/write logic.
  assert.ok(
    sw.indexOf('if (isApiPath') >= 0
    && sw.indexOf('if (isApiPath') < sw.indexOf('event.respondWith'),
    'api guard short-circuits before any respondWith/caching',
  );
});

test('install survives an offline first visit (shell precache is best-effort)', async () => {
  const sw = await readFile(join(root, 'public', 'sw.js'), 'utf8');
  const install = sw.slice(
    sw.indexOf("addEventListener('install'"),
    sw.indexOf("addEventListener('activate'"),
  );
  assert.match(install, /cache\.add/, 'install precaches the shell');
  const addLine = install.indexOf('cache.add');
  const catchLine = install.indexOf('catch', addLine);
  const skipLine = install.indexOf('skipWaiting');
  assert.ok(catchLine > addLine && catchLine < skipLine, 'shell precache failure is caught, install still completes');
});

test('manifest ships raster icons (192, 512, maskable 512) besides the SVG', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  const has = (sizes, purpose) => manifest.icons.some(
    (icon) => icon.type === 'image/png' && icon.sizes === sizes && icon.purpose === purpose,
  );
  assert.ok(has('192x192', 'any'), '192px PNG (Android install)');
  assert.ok(has('512x512', 'any'), '512px PNG (splash screen)');
  assert.ok(has('512x512', 'maskable'), 'maskable PNG (adaptive icons)');
});

test('index.html links a real SVG favicon and an apple-touch-icon (no emoji data URI)', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /rel="icon"[^>]*icon\.svg/u);
  assert.match(html, /rel="apple-touch-icon"[^>]*\.png/u);
  assert.doesNotMatch(html, /data:image\/svg\+xml/u, 'glyph-in-a-data-URI favicon is font dependent');
});

test('app icon artwork is vector paths, not a font glyph', async () => {
  const svg = await readFile(join(root, 'public', 'assets', 'icons', 'icon.svg'), 'utf8');
  assert.doesNotMatch(svg, /<text/u, 'a <text> icon renders differently per installed font');
  assert.match(svg, /<path/u);
});
