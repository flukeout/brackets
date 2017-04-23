/**
 * This is a service worker stub, meant only to allow development builds
 * to load properly. The actual bramble-sw.js file is generated at build
 * time, see Gruntfile and swPrecache task.
 */

// We only need the Cache Storage server in src/ builds
self.importScripts("bramble-live-dev-cache-sw.js");
