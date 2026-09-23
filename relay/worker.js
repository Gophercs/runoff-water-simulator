// Runoff relay: a Cloudflare Worker that lets the browser read the Welsh Government's lidar file.
// Their storage serves partial reads (HTTP Range) but without the cross-site header browsers need.
// This passes range reads through and adds the header. It only relays the allowed prefix below,
// so it can't be used as a general proxy.
const ALLOWED = [
  'https://dmwproductionblob.blob.core.windows.net/cogs/lidar/',   // Welsh Government lidar
  'https://environment.data.gov.uk/spatialdata/',                  // Environment Agency lidar
  'https://ows.remotesensing.data.gov.scot/geoserver/',            // Scottish Government services
  'https://datamap.gov.wales/geoserver/'                           // DataMapWales services
];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  'Access-Control-Max-Age': '86400'
};
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const target = new URL(request.url).searchParams.get('url') || '';
    if (!ALLOWED.some(p => target.startsWith(p))) return new Response('Not allowed', { status: 403, headers: CORS });
    const range = request.headers.get('Range');
    // ranged reads of huge files go straight through (caching them makes Cloudflare fetch far more than asked)
    const upstream = range ? await fetch(target, { method: request.method, headers: { Range: range } }) : await fetch(target, { method: request.method, cf: { cacheEverything: true, cacheTtl: 86400 } });
    const headers = new Headers(CORS);
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      const v = upstream.headers.get(h); if (v) headers.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
