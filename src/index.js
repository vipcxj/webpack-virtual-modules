var VirtualStats = require('./virtual-stats');
var RawSource = require("webpack-sources").RawSource;
var path = require('path');
var debug = require('debug')('webpack-overlay-modules');

var uid = process.getuid && process.getuid() || 0;
var gid = process.getgid && process.getgid() || 0;
var inode = 45000000;

function checkActivation(instance) {
  if (!instance._compiler) {
    throw new Error("You must use this plugin only after creating webpack instance!");
  }
}

function OverlayModulesPlugin(modules) {
  this._staticModules = modules;
}

function getModulePath(filePath, compiler) {
  return path.isAbsolute(filePath) ? filePath : path.join(compiler.context, filePath);
}

OverlayModulesPlugin.prototype.writeModule = function(filePath, contents) {
  var self = this;

  checkActivation(self);

  var len = contents ? contents.length : 0;
  var time = Date.now();

  var stats = new VirtualStats({
    dev: 8675309,
    nlink: 0,
    uid: uid,
    gid: gid,
    rdev: 0,
    blksize: 4096,
    ino: inode++,
    mode: 33188,
    size: len,
    blocks: Math.floor(len / 4096),
    atime: time,
    mtime: time,
    ctime: time,
    birthtime: time,
  });
  var modulePath = getModulePath(filePath, self._compiler);

  self._timestamps = self._timestamps || {};
  self._timestamps[modulePath] = time;

  debug(self._compiler.name, "Write module:", modulePath, contents);

  self._compiler.inputFileSystem._writeOverlayFile(modulePath, stats, contents);
  if (self._watcher && self._watcher.compiler.watchFileSystem.watcher.fileWatchers.length) {
    self._watcher.compiler.watchFileSystem.watcher.fileWatchers.forEach(function(fileWatcher) {
      if (fileWatcher.path === modulePath) {
        debug(self._compiler.name, "Emit file change:", modulePath, time);
        fileWatcher.emit("change", time, null);
      }
    });
  }
};

OverlayModulesPlugin.prototype.apply = function(compiler) {
  var self = this;

  self._compiler = compiler;

  if (self._staticModules) {
    Object.keys(self._staticModules).forEach(function(path) {
      self.writeModule(path, self._staticModules[path]);
    });
  }

  compiler.plugin("after-environment", function() {
    var originalPurge = compiler.inputFileSystem.purge;
    compiler.inputFileSystem.purge = function() {
      originalPurge.call(this, arguments);
      if (this._overlayFiles) {
        Object.keys(this._overlayFiles).forEach(function(file) {
          var data = this._overlayFiles[file];
          this._statStorage.data[file] = [null, data.stats];
          this._readFileStorage.data[file] = [null, data.contents];
        }.bind(this));
      }
    };

    compiler.inputFileSystem._writeOverlayFile = function(file, stats, contents) {
      this._overlayFiles = this._overlayFiles || {};
      this._overlayFiles[file] = {stats: stats, contents: contents};
      this._statStorage.data[file] = [null, stats];
      this._readFileStorage.data[file] = [null, contents];
    };
  });

  compiler.plugin("watch-run", function(watcher, callback) {
    self._watcher = watcher;
    callback();
  });

  compiler.plugin("compilation", function(compilation) {
    compilation.plugin("seal", function() {
      self._sealTime = Date.now();
      debug(compiler.name, "seal");
    });
    compilation.plugin("after-seal", function(callback) {
      debug(compiler.name, "after-seal");
      if (self._timestamps) {
        compilation.modules.forEach(function(module) {
          var time = self._timestamps[module.resource];
          if (time && time > self._sealTime) {
            var contents = compiler.inputFileSystem.readFileSync(module.resource).toString();
            debug(compiler.name, "Replacing module:", module.resource, contents);

            module._source = new RawSource(contents);
          }
        });
      }
      callback();
    });
  });
};

module.exports = OverlayModulesPlugin;