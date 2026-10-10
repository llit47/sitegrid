import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { Plugin } from 'vite';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// The worker's executable code is part of the shell identity, including on rollback.
export function pwaBuild(): Plugin {
  return {
    name: 'sitegrid-static-shell', apply: 'build', enforce: 'post',
    async generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset' || typeof html.source !== 'string') throw new Error('Missing built shell');
      const worker = await readFile(new URL('../src/pwa/service-worker.js', import.meta.url), 'utf8');
      const icon = await readFile(new URL('../src/pwa/icon.svg', import.meta.url));
      const release = JSON.parse(await readFile('release.json', 'utf8')) as { version: string };
      const staticAssets = Object.values(bundle).filter(entry => entry.fileName.startsWith('assets/'));
      const version = hash([process.env.SITEGRID_RELEASE_VERSION ?? release.version, worker, icon.toString(), html.source, ...staticAssets.map(entry =>
        entry.fileName + hash(entry.type === 'chunk' ? entry.code : entry.source))].join('\n'));
      const base = `pwa/${version}`;
      const emit = (fileName: string, source: string | Uint8Array) => {
        this.emitFile({ type: 'asset', fileName, source });
        return { url: `/${fileName}`, sha256: hash(source) };
      };
      const assets = staticAssets.map(entry => ({ url: `/${entry.fileName}`, sha256: hash(entry.type === 'chunk' ? entry.code : entry.source) }));
      for (const size of [180, 192, 512]) assets.push(emit(`${base}/icon-${size}.png`, await sharp(icon).resize(size, size).png().toBuffer()));
      assets.push(emit(`${base}/manifest.webmanifest`, JSON.stringify({
        id: '/', name: 'SiteGrid', short_name: 'SiteGrid', lang: 'pl', start_url: '/', scope: '/', display: 'standalone',
        theme_color: '#122f32', background_color: '#f5f7ef',
        icons: [192, 512].map(size => ({ src: `/${base}/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })),
      })));
      html.source = html.source.replace('<!-- pwa -->', `<link rel="manifest" href="/${base}/manifest.webmanifest" /><link rel="apple-touch-icon" href="/${base}/icon-180.png" /><meta name="apple-mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-title" content="SiteGrid" />`);
      const shell = `/${base}/shell.html`;
      assets.push(emit(shell.slice(1), html.source));
      emit('sw.js', worker.replace('__SITEGRID_SHELL__', JSON.stringify({ version, shell, assets })));
    },
  };
}
