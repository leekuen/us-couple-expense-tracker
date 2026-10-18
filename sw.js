const CACHE_PREFIX = 'couple-expense-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const SHELL_FILES = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg', './apps-script.gs'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache.addAll() 走一般 fetch，會被 GitHub Pages 的 Cache-Control: max-age=600
      // 卡在瀏覽器 HTTP 快取，抓到舊檔；{ cache: 'reload' } 強制每個檔案都走網路。
      Promise.all(SHELL_FILES.map((url) => fetch(url, { cache: 'reload' }).then((resp) => cache.put(url, resp))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // 同網域（leekuen.github.io）底下還有別的 PWA 在用 Cache Storage，
    // 只能清自己前綴的舊版本，不能把全部不是 CACHE_NAME 的都刪掉。
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// 只攔截同源 GET（app 殼層）。Apps Script 同步是跨網域 POST，一律直接走網路不碰。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req).then((resp) => {
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
