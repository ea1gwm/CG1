/* =============================================================
   CG1 PWA — Service Worker
   Cachea index.html + plantillas + iconos para funcionar offline

   IMPORTANTE: cuando subas App.version en index.html, sube también
   este CACHE_VERSION a la misma versión (con prefijo 'cg1-v').
   Eso fuerza al SW a invalidar la cache vieja.
   ============================================================= */

const CACHE_VERSION = 'cg1-v0.9.0';
const PRECACHE_URLS = [
  './',
  './index.html',
  './postes.pdf',
  './ccrr.pdf',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './favicon.png',
  './db-postes.json.gz',
  './db-camaras.json.gz'
];

// CDNs externos a cachear cuando se carguen
const RUNTIME_CACHEABLE = [
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

/* === INSTALL: precache de la "shell" de la app === */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // addAll falla si una sola URL falla; usamos add individual para tolerancia
      return Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(url).catch(err => {
          console.warn('[SW] No se pudo cachear', url, err);
        }))
      );
    }).then(() => self.skipWaiting())
  );
});

/* === ACTIVATE: limpiar caches antiguas + recargar pestañas abiertas === */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      );
    })
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then((clients) => {
      // Forzar recarga de todas las pestañas/instancias abiertas para que
      // carguen el HTML/JS nuevo en lugar de seguir con la versión vieja.
      clients.forEach((client) => {
        try { client.navigate(client.url); } catch(e) {}
      });
    })
  );
});

/* === FETCH ===
   Estrategia:
   - Para archivos del precache (mismo origen): cache-first con fallback a red
   - Para CDNs externos (pdf-lib, fonts): stale-while-revalidate (sirve cache si hay, refresca en background)
   - Para todo lo demás: network-first
*/
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Documento HTML / navegación → network-first
  // (así una versión nueva en GitHub llega siempre que haya conexión,
  //  sin quedar atrapada en una cache vieja)
  if (req.mode === 'navigate' ||
      url.pathname.endsWith('/') ||
      url.pathname.endsWith('/index.html')) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // Resto de mismo origen (pdf, iconos, manifest) → cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // CDN externo → stale-while-revalidate
  if (RUNTIME_CACHEABLE.some(host => url.hostname.includes(host))) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Resto: network-first
  event.respondWith(networkFirst(req));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    // Cachear silenciosamente si tiene éxito
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    // Sin red y sin cache: devolver respuesta de error simple
    return new Response('Sin conexión y sin cache', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(response => {
    if (response && response.status === 200) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => cached);
  return cached || networkPromise;
}

// Network-first específico para el HTML: intenta la red, actualiza la cache,
// y solo cae a la cache si no hay conexión.
async function networkFirstHTML(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(request) || await caches.match('./index.html') || await caches.match('./');
    if (cached) return cached;
    throw err;
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

/* === Mensajes del cliente (para forzar update, etc.) === */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
