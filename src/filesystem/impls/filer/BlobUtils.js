/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, URL, Blob */

define(function (require, exports, module) {
    "use strict";

    // BlobUtils provides an opportunistic cache for BLOB Object URLs
    // which can be looked-up synchronously.
    var Content = require("filesystem/impls/filer/lib/content");
    var StartupState = require("bramble/StartupState");
    var FilerUtils = require("filesystem/impls/filer/FilerUtils");
    var Path = FilerUtils.Path;
    var decodePath = FilerUtils.decodePath;

    // 2-way cache for blob URL to path for looking up either way:
    // * paths - paths keyed on blobUrls
    // * blobs - blobUrls keyed on paths
    var paths  = {};
    var blobURLs = {};

    // TODO: figure out if you can hold a cache long-term
    var cache;

    // Generate a BLOB URL for the given filename and cache it
    function _cache(filename, url) {
        filename = Path.normalize(filename);

        // If there's an existing entry for this, remove it.
        remove(filename);

        // Now make a new set of cache entries
        blobURLs[filename] = url;
        paths[url] = filename;
    }

    function _cache2(path, blob, type, callback) {
        if(!cache) {
            return;
        }

        var response = new Response(blob, {
            status: 200,
            statusText: "ThimbleCache"
        });

        var headers = new Headers();
        headers.append("Content-Type", type);

        var url = pathToUrl(path);
        console.log("_cache2", path, url);

        var request = new Request(url, {
            method: "GET",
            headers: headers
        });

        // TODO: this is a hack, and will leak
        blobURLs[path] = url;
        paths[url] = path;

        cache.put(request, response).then(callback, callback);
    };

    function _remove(filename) {
        var url = blobURLs[filename];
        // The first time a file is written, we won't have
        // a stale cache entry to clean up.
        if(!url) {
            return;
        }

        delete blobURLs[filename];
        delete paths[url];
        // Delete the reference from memory
        URL.revokeObjectURL(url);
    }

    function _remove2(filename) {
        if(!cache) {
            return;
        }
        // TODO: async, error handling
        var url = pathToUrl(filename);
        cache.delete(url);
    }

    // Remove the cached BLOB URL for the given file path, or files beneath
    // this path if it is a dir. Returns all file paths that were removed.
    function remove(path) {
        path = decodePath(path);
        path = Path.normalize(path);
        var removed = [];

        // If this is a dir path, look for other paths entries below it
        Object.keys(blobURLs).forEach(function(key) {
            // If this filename matches exactly, or is a root path (i.e., other
            // filenames begin with "<path>/...", remove it. Otherwise just skip.
            if(key === path || key.indexOf(path + "/") === 0) {
                removed.push(key);
                _remove(key);
            }
        });

        // TODO: refactor this
        _remove2(path);

        return removed;
    }

    // Update the cached records for the given filename
    function rename(oldPath, newPath) {
        oldPath = decodePath(oldPath);
        oldPath = Path.normalize(oldPath);
        newPath = decodePath(newPath);
        newPath = Path.normalize(newPath);

        var url = blobURLs[oldPath];

        blobURLs[newPath] = url;
        paths[url] = newPath;

        delete blobURLs[oldPath];
    }

    // NOTE: make sure that we always return the filename unchanged if we
    // don't have a cached URL.  Don't return a normalized, decoded version.
    function getUrl(filename) {
        var url = blobURLs[Path.normalize(decodePath(filename))];

        // We expect this to exist, if it doesn't,
        // return path back unchanged
        return url || filename;
//        return pathToUrl(Path.normalize(decodePath(filename)));
    }

    // Given a BLOB URL, lookup the associated filename
    function getFilename(blobUrl) {
        var filename = paths[blobUrl];

        // We expect this to exist, if it doesn't,
        // return path back unchanged
        if(!filename) {
            return blobUrl;
        }
        return filename;
    }

    // Get a DownloadUrl suitable for the DataTransfer object to allow dragging
    // files out of the browser to OS. See https://www.thecssninja.com/html5/gmail-dragout.
    // Only works in Chrome at present, similar to how attachments in gmail work.
    function getDownloadUrl(filename) {
        var blobUrl = getUrl(filename);
        var basename = Path.basename(filename);
        var ext = Path.extname(filename);
        var mimeType = Content.mimeFromExt(ext);

        return mimeType + ":" + basename + ":" + blobUrl;
    }

    // Create a Blob URL Object, and manage its lifetime by caching.
    // Subsequent calls to create a URL for this path will auto-revoke an existing URL.
    function createURL(path, data, type, callback) {
        path = decodePath(path);
        var blob = new Blob([data], {type: type});

        // NOTE: cache() will clean up existing URLs for this path.
        var url = URL.createObjectURL(blob);
        _cache(path, url);

        // TODO: refactor this
        _cache2(path, blob, type, function(err) {
            if(err) {
                return callback(err);
            }

            console.log("BlobUtils.createURL", path, url);

            callback(null, url);
        });
    }

    // Create (or wipe and recreate) the caches we use
    function init(callback) {
        var root = StartupState.project("root");

        paths  = {};
        blobURLs = {};

        if(!('caches' in window)) {
            return callback();
        }

        // Delete existing cache, and recreate empty cache for this root
        caches.delete(root).then(function() {
            caches.open(root).then(function(rootCache) {
                // TODO: error handling.
                cache = rootCache;
                callback();
            });
        }).catch(callback);
    }

    // We use http://<host>:port/dist/vfs/project/root. Don't put any files in vfs/
    function getBaseUrl() {
        var location = window.location;
        return location.origin + "/dist/vfs" + StartupState.project("root") + "/"; //"/virtual/live-dev-cache/";
    }

    function pathToUrl(path) {
        var base = getBaseUrl();
        var root = StartupState.project("root");

        return base + path.replace(root, "").replace(/^\/?/, "");
    }

    exports.init = init;
    exports.getBaseUrl = getBaseUrl;
    exports.remove = remove;
    exports.rename = rename;
    exports.getUrl = getUrl;
    exports.getFilename = getFilename;
    exports.createURL = createURL;
    exports.getDownloadUrl = getDownloadUrl;
});
