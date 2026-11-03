'use strict';
const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  outfile: 'dist/app.js',
  platform: 'browser',
  target: 'chrome140',
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('Desktop UI built.');
