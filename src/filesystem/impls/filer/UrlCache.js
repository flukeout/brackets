/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, URL, Blob */

define(function (require, exports, module) {
    "use strict";

    var StartupState = require("bramble/StartupState");
    var _ = require("thirdparty/lodash");
    var Async = require("utils/Async");
    var FilerUtils = require("filesystem/impls/filer/FilerUtils");
    var Content = require("filesystem/impls/filer/lib/content");
    var Path = FilerUtils.Path;
    var decodePath = FilerUtils.decodePath;

    var _provider;

    function fixPath(path) {
        return Path.normalize(decodePath(path));
    }

    /**
     * UrlProviderBase manages mappings between filesystem paths and URLs.
     */
    function UrlProviderBase() {
        this.paths = {};
        this.urls = {};
    }
    UrlProviderBase.prototype.getUrl = function(filename) {
        // NOTE: make sure that we always return the filename unchanged if we
        // don't have a cached URL.  Don't return a normalized, decoded version.
        var url = this.urls[fixPath(filename)];

        // We expect this to exist, if it doesn't,
        // return path back unchanged
        return url || filename;
    };
    UrlProviderBase.prototype.getFilename = function(url) {
        var filename = this.paths[url];

        // We expect this to exist, if it doesn't,
        // return path back unchanged
        if(!filename) {
            return url;
        }
        return filename;
    };


    /**
     * BlobUrlProvider uses Blob URLs in browsers that don't support CacheStorage
     */
    function BlobUrlProvider() {
        UrlProviderBase.call(this);

        this.baseUrl = window.location.href;
        this.shouldRewriteUrls = true;
    }
    BlobUrlProvider.prototype = Object.create(UrlProviderBase.prototype);
    BlobUrlProvider.prototype.constructor = BlobUrlProvider;

    BlobUrlProvider.prototype.init = function(callback) {
        _.defer(callback);
    };
    BlobUrlProvider.prototype.createURL = function(filename, blob, type, callback) {
        var self = this;

        // If there's an existing entry for this, remove it.
        this.remove(filename, function(err) {
            if(err) {
                return callback(err);
            }

            // Now make a new set of cache entries
            var url = URL.createObjectURL(blob);

            self.urls[filename] = url;
            self.paths[url] = filename;

            callback(null, url);
        });
    };
    BlobUrlProvider.prototype.remove = function(path, callback) {
        var self = this;
        var removed = [];

        // If this is a dir path, look for other paths entries below it
        Object.keys(self.urls).forEach(function(key) {
            var url = self.urls[key];

            // The first time a file is written, we won't have
            // a stale cache entry to clean up.
            if(!url) {
                return;
            }

            // If this filename matches exactly, or is a root path (i.e., other
            // filenames begin with "<path>/...", remove it. Otherwise just skip.
            if(key === path || key.indexOf(path + "/") === 0) {
                removed.push(key);

                delete self.urls[key];
                delete self.paths[url];

                // Delete the reference from memory
                URL.revokeObjectURL(url);
            }
        });

        _.defer(callback, null, removed);
    };
    BlobUrlProvider.prototype.rename = function(oldPath, newPath, callback) {
        var url = this.urls[oldPath];

        this.urls[newPath] = url;
        this.paths[url] = newPath;
        delete this.urls[oldPath];

        _.defer(callback);
    };


    /**
     * CacheStorageUrlProvider uses CacheStorage and Service Workers in compatible browsers.
     */
    function CacheStorageUrlProvider() {
        UrlProviderBase.call(this);

        // Construct an absolute URL for our project root
        var prefix = brackets.env === "production" ? "/dist" : "/src";
        var a = document.createElement("a");
        this.generateVFSUrlForPath = function(path) {
            a.href = prefix + "/vfs" + path;
            return a.href;
        };

        this.baseUrl = this.generateVFSUrlForPath(StartupState.project("root")) + "/";
        this.shouldRewriteUrls = false;
    }
    CacheStorageUrlProvider.prototype = Object.create(UrlProviderBase.prototype);
    CacheStorageUrlProvider.prototype.constructor = CacheStorageUrlProvider;

    CacheStorageUrlProvider.prototype.init = function(callback) {
        var self = this;
        var projectCacheName = Path.join("vfs", StartupState.project("root"));

        // Delete existing cache for this root, and recreate empty cache.
        caches.delete(projectCacheName).then(function() {
            caches.open(projectCacheName).then(function(cache) {
                self.cache = cache;
                callback();
            });
        }).catch(callback);
    };
    CacheStorageUrlProvider.prototype.createURL = function(filename, blob, type, callback) {
        var response = new Response(blob, {
            status: 200,
            statusText: "Served from Thimble's Offline Cache"
        });

        var headers = new Headers();
        headers.append("Content-Type", type);

        var url = this.generateVFSUrlForPath(filename);
        var request = new Request(url, {
            method: "GET",
            headers: headers
        });

        this.urls[filename] = url;
        this.paths[url] = filename;

        this.cache.put(request, response).then(function() {
            callback(null, url);
        }, callback);
    };
    CacheStorageUrlProvider.prototype.remove = function(path, callback) {
        var removed = [];

        function _maybeRemove(pathPart) {
            var deferred = new $.Deferred();
            var url = this.urls[pathPart];

            // The first time a file is written, we won't have
            // a stale cache entry to clean up.
            if(!url) {
                return deferred.resolve().promise();
            }

            // If this filename matches exactly, or is a root path (i.e., other
            // filenames begin with "<path>/...", remove it. Otherwise just skip.
            if(pathPart === path || pathPart.indexOf(path + "/") === 0) {
                removed.push(pathPart);

                delete this.urls[pathPart];
                delete this.paths[url];

                this.cache.delete(url).then(deferred.resolve, deferred.reject);
            } else {
                // Nothing to be done for this path, skip.
                deferred.resolve();
            }

            return deferred.promise();
        }

        // If this is a dir path, look for other paths entries below it
        Async.doSequentially(Object.keys(this.urls), _maybeRemove, false)
             .done(function() {
                 callback(null, removed);
             })
             .fail(function(err) {
                 callback(err);
             });
    };
    CacheStorageUrlProvider.prototype.rename = function(oldPath, newPath, callback) {
        var self = this;
        var oldUrl = this.urls[oldPath];

        // Get the existing Response, and re-cache it with a new Request
        // which uses the correct path/url.
        self.cache.match(oldUrl).then(function(response) {
            var type = Content.mimeFromExt(Path.extname(newPath));
            var headers = new Headers();
            headers.append("Content-Type", type);

            var newUrl = self.generateVFSUrlForPath(newPath);
            var request = new Request(newUrl, {
                method: "GET",
                headers: headers
            });

            this.urls[newPath] = newUrl;
            this.paths[newUrl] = newPath;

            // TODO: confirm I need to clone the response.
            self.cache.put(request, response.clone())
                .then(function() {
                    self.remove(oldPath, callback);
                })
                .catch(callback);
        }, callback);
    };


    function init(callback) {
        // Prefer CacheStorage if we have access to it.
        _provider = 'caches' in window ?
            new CacheStorageUrlProvider() :
            new BlobUrlProvider();

        // TODO: for testing, uncomment this, currently forcing blob urls.
        _provider = new BlobUrlProvider();

        _provider.init(callback);
    }

    function remove(path, callback) {
        path = fixPath(path);
        _provider.remove(path, callback);
    }

    function rename(oldPath, newPath, callback) {
        oldPath = fixPath(oldPath);
        newPath = fixPath(newPath);
        _provider.rename(oldPath, newPath, callback);
    }

    function getBaseUrl() {
        return _provider.baseUrl;
    }

    function getShouldRewriteUrls() {
        return _provider.shouldRewriteUrls;
    }

    function getUrl(filename) {
        // NOTE: we intentionally don't call fixPath() on filename
        return _provider.getUrl(filename);
    }

    function getFilename(url) {
        return _provider.getFilename(url);
    }

    function createURL(path, data, type, callback) {
        path = fixPath(path);
        // TODO: confirm I need to get type passed in vs. figure it out here...
        var blob = new Blob([data], {type: type});
        _provider.createURL(path, blob, type, callback);
    }

    exports.init = init;
    exports.getBaseUrl = getBaseUrl;
    exports.getShouldRewriteUrls = getShouldRewriteUrls;
    exports.remove = remove;
    exports.rename = rename;
    exports.getUrl = getUrl;
    exports.getFilename = getFilename;
    exports.createURL = createURL;
});
