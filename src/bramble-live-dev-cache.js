this.addEventListener('fetch', function(event) {
    "use strict";
    event.respondWith(
        caches.match(event.request)
        .then(function(response) {
            // Either we have a cached response, or we need to go to the network
            return response || fetch(event.request);
        })
        .catch(function(error) {
            console.error("Error: ", error);
        })
    );
});
