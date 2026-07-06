// Builds the loadable extension into ./extension
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'fs';

mkdirSync('extension', { recursive: true });

const bundle = (entry, outfile) =>
  build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    outfile,
    target: 'chrome111', // world:MAIN content scripts need Chrome 111+
    minify: false,
  });

await Promise.all([
  bundle('src/popup/popup.js', 'extension/popup.js'),
  bundle('src/background.js', 'extension/background.js'),
  bundle('src/approval/approval.js', 'extension/approval.js'),
  bundle('src/content.js', 'extension/content.js'),
  bundle('src/inpage.js', 'extension/inpage.js'),
]);

cpSync('src/popup/popup.html', 'extension/popup.html');
cpSync('src/popup/popup.css', 'extension/popup.css');
cpSync('src/approval/approval.html', 'extension/approval.html');
cpSync('manifest.json', 'extension/manifest.json');
cpSync('icons', 'extension/icons', { recursive: true });

console.log('Built -> extension/');
