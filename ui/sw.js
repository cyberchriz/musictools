const CACHE_NAME = 'tonnetz-pro-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './app.js',
    './jszip.min.js',
    './manifest.json',
    './icon-192.png'
    // Note: If external CSS or external sample WAV files are added later, their URLs should be added here!
];

// 1. Install Phase: Download and cache all assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Opened cache, saving Tonnetz Pro assets...');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// 2. Fetch Phase: Serve from Cache first, fall back to Network
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            // If the file is in the cache, return it instantly!
            if (response) return response;
            // Otherwise, fetch it from the internet.
            return fetch(event.request);
        })
    );
});

// 3. Activate Phase: Clean up old caches if we update the app (e.g., v1 -> v2)
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});