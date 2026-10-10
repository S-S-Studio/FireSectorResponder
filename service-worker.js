const APP_CACHE='firesector-responder-shell-v007';
const TILE_CACHE='firesector-responder-tiles-v007';
const MAX_TILE_ENTRIES=320;

const SHELL=[
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './404.html'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(APP_CACHE).then(cache=>cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  const keep=new Set([APP_CACHE,TILE_CACHE]);
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>!keep.has(key)).map(key=>caches.delete(key))))
  );
  self.clients.claim();
});

async function trimCache(cacheName,maxEntries){
  const cache=await caches.open(cacheName);
  const keys=await cache.keys();
  if(keys.length<=maxEntries)return;
  const remove=keys.slice(0,keys.length-maxEntries);
  await Promise.all(remove.map(key=>cache.delete(key)));
}

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;

  const url=new URL(event.request.url);
  const sameOrigin=url.origin===self.location.origin;
  const isTile=(
    url.hostname==='tile.openstreetmap.org' ||
    url.hostname==='server.arcgisonline.com'
  );

  if(sameOrigin){
    event.respondWith(
      fetch(event.request,{cache:'no-store'})
        .then(response=>{
          if(response.ok){
            const copy=response.clone();
            caches.open(APP_CACHE).then(cache=>cache.put(event.request,copy));
          }
          return response;
        })
        .catch(()=>caches.match(event.request).then(r=>r||caches.match('./index.html')))
    );
    return;
  }

  if(isTile){
    event.respondWith(
      caches.open(TILE_CACHE).then(async cache=>{
        const cached=await cache.match(event.request);
        if(cached)return cached;
        const response=await fetch(event.request);
        cache.put(event.request,response.clone()).then(()=>trimCache(TILE_CACHE,MAX_TILE_ENTRIES));
        return response;
      }).catch(()=>fetch(event.request))
    );
    return;
  }

});
