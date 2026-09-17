// Synthetic npm archive for offline tests. This is not publication evidence.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export function archiveFixture(entries) {
  const chunks = [];
  for (const [name, content, type = 48] of entries) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(32, 148, 156);
    header[156] = type;
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

export function publishedFixture({ version = '1.17.0', tools = 157, source, extra = [] } = {}) {
  const tarball = archiveFixture([
    ['package/package.json', JSON.stringify({ name: '@frihet/mcp-server', version })],
    ['package/dist/tools/fixture.js', source ?? Array.from({ length: tools }, (_, index) => `server.registerTool("fixture_${index}", {}, () => {});`).join('\n')],
    ...extra,
  ]);
  return { tarball, metadata: {
    name: '@frihet/mcp-server', version,
    dist: {
      tarball: `https://registry.npmjs.org/@frihet/mcp-server/-/mcp-server-${version}.tgz`,
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    },
  } };
}
