// Cloudflare Pages Function: deploys with the site and answers at /relay.
// The national lidar services send their data without the header browsers need to read it from another
// site, so Runoff asks through here instead: same address as the app, so no cross-site rules apply.
// Only the lidar services below are relayed, so this can't be used as a general proxy.
const ALLOWED = [
  'https://environment.data.gov.uk/spatialdata/',                  // Environment Agency lidar
  'https://dmwproductionblob.blob.core.windows.net/cogs/lidar/',   // Welsh Government lidar
  'https://datamap.gov.wales/geoserver/',                          // DataMapWales services
  'https://ows.remotesensing.data.gov.scot/geoserver/'             // Scottish Government services
];
export async function onRequest({ request }) {
  const target = new URL(request.url).searchParams.get('url') || '';
  if (!ALLOWED.some(p => target.startsWith(p))) return new Response('Not allowed', { status: 403 });
  const range = request.headers.get('Range');
  const upstream = await fetch(target, { headers: range ? { Range: range } : {}, cf: { cacheEverything: true, cacheTtl: 86400 } });
  const headers = new Headers({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' });
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const v = upstream.headers.get(h); if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
