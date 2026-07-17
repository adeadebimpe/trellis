import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info'
};

const webviewConfig = {
  entryPoints: ['webview/main.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: 'dist/webview/main.js',
  sourcemap: true,
  logLevel: 'info',
  loader: {
    '.css': 'css'
  }
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig)
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching Trellis extension and webview...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig)
  ]);
}
