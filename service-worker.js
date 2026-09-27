'use strict';

const CACHE = 'cone-pwa-v1.0.4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './excel-export.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './templates/cone-template.xlsx'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('cone-pwa-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if(event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;

  // Version checks must always go to the network. Query-string cache busting is used by the app.
  if(url.pathname.endsWith('/version.json')){
    event.respondWith(fetch(event.request, {cache:'no-store'}));
    return;
  }

  // Network-first while online so newly deployed app files are picked up without manual cache clearing.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if(response && response.ok){
          const copy=response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const direct=await caches.match(event.request);
        if(direct) return direct;
        const ignoreSearch=await caches.match(event.request,{ignoreSearch:true});
        if(ignoreSearch) return ignoreSearch;
        if(event.request.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline');
      })
  );
});
