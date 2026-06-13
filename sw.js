// Momentum Coach AI — Service Worker
// アプリシェルをキャッシュしてオフライン起動を可能にする。
// 同一オリジンのファイルは network-first(常に最新を取得、失敗時のみキャッシュ)なので
// 頻繁な更新もそのまま反映される。React/Babel/MediaPipe等のCDNはネットワーク任せ。
const CACHE = "vbmc-v2";
const ASSETS = [
  "./", "./index.html", "./momentum-coach.jsx", "./manifest.json",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // CDN等はそのまま
  e.respondWith(
    fetch(e.request)
      .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then(m => m || caches.match("./index.html")))
  );
});
