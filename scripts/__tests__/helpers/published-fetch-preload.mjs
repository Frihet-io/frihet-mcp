// Only test subprocesses import this file. Unexpected requests fail immediately.
import { publishedFixture } from './published-artifact-fixture.mjs';
const { metadata, tarball } = publishedFixture();
globalThis.fetch = async (url) => {
  const address = String(url);
  if (address === 'https://registry.npmjs.org/@frihet%2fmcp-server/1.17.0' ||
      address === 'https://registry.npmjs.org/@frihet%2fmcp-server/latest') {
    return new Response(JSON.stringify(metadata));
  }
  if (address === metadata.dist.tarball) return new Response(tarball);
  if (address === 'https://registry.npmjs.org/@frihet%2fmcp-server/9.9.9') return new Response('', { status: 404 });
  throw new Error(`Unexpected test network request: ${address}`);
};
