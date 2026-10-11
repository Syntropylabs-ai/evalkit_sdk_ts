import { gunzipSync } from 'node:zlib';

// The exporter gzips what it posts to /v1/ingest; a stand-in receiver reads the body the way the real one does.
export function ingestBody(init) {
  const headers = init?.headers ?? {};
  const encoding = String(headers['Content-Encoding'] ?? headers['content-encoding'] ?? '').toLowerCase();
  const raw = encoding === 'gzip' ? gunzipSync(init.body) : init.body;
  return JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
}
