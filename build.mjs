// Builds the loadable extension into ./extension
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'fs';

mkdirSync('extension', { recursive: true });

await build({
  entryPoints: ['src/popup/popup.js'],
  bundle: true,
  format: 'iife',
  outfile: 'extension/popup.js',
  target: 'chrome110',
  minify: false,
});

await build({
  entryPoints: ['src/background.js'],
  bundle: true,
  format: 'iife',
  outfile: 'extension/background.js',
  target: 'chrome110',
  minify: false,
});

cpSync('src/popup/popup.html', 'extension/popup.html');
cpSync('src/popup/popup.css', 'extension/popup.css');
cpSync('manifest.json', 'extension/manifest.json');
cpSync('icons', 'extension/icons', { recursive: true });

console.log('Built -> extension/');
