import { defineConfig } from 'vite';

// Chess Arena — static SPA, GitHub Pages ready.
// base './' makes all bundled asset URLs relative, so the site works at
// https://<user>.github.io/<repo>/ without any extra configuration.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
});
