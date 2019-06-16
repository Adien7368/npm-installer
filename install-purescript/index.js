'use strict';

const fs = require('fs');
const {execFile} = require('child_process');
const path = require('path');
const {promisify} = require('util');
const {Writable} = require('stream');

const arch = require('arch');
const {create, Unpack} = require('tar');
const cacache = require('cacache');
const inspectWithKind = require('inspect-with-kind');
const isPlainObj = require('is-plain-obj');
const Observable = require('zen-observable');
const pump = require('pump');
const runInDir = require('run-in-dir');
const envPaths = require('env-paths');

const downloadOrBuildPurescript = require('../download-or-build-purescript/index.js');

function addId(obj, id) {
	Object.defineProperty(obj, 'id', {
		value: id,
		writable: true
	});

	return obj;
}

const CACHE_ROOT_DIR = envPaths('purescript-npm-installer').cache;
const CACHE_KEY = 'install-purescript:binary';
const MAX_READ_SIZE = 30 * 1024 * 1024;
const defaultBinName = `purs${process.platform === 'win32' ? '.exe' : ''}`;
const cacheIdSuffix = `-${process.platform}-${arch()}`;

module.exports = function installPurescript(...args) {
	return new Observable(observer => {
		const argLen = args.length;

		if (argLen > 1) {
			const error = new RangeError(`Exepcted 0 or 1 argument ([<Object>]), but got ${argLen} arguments.`);

			error.code = 'ERR_TOO_MANY_ARGS';
			throw error;
		}

		const [options = {}] = args;

		if (args.length === 1) {
			if (!isPlainObj(options)) {
				throw new TypeError(`Expected an object to set install-purescript options, but got ${
					inspectWithKind(options)
				}.`);
			}

			if (options.forceReinstall !== undefined && typeof options.forceReinstall !== 'boolean') {
				throw new TypeError(`Expected \`forceReinstall\` option to be a Boolean value, but got ${
					inspectWithKind(options.forceReinstall)
				}.`);
			}
		}

		const subscriptions = new Set();

		function cancelInstallation() {
			for (const subscription of subscriptions) {
				subscription.unsubscribe();
			}
		}

		const binName = typeof options.rename === 'function' ? path.normalize(`${options.rename(defaultBinName)}`) : defaultBinName;
		const cwd = process.cwd();
		const binPath = path.join(cwd, binName);
		const cacheId = `${options.version || downloadOrBuildPurescript.defaultVersion}${cacheIdSuffix}`;

		function main({brokenCacheFound = false} = {}) {
			const cacheCleaning = (async () => {
				if (brokenCacheFound) {
					try {
						await cacache.rm.entry(CACHE_ROOT_DIR, CACHE_KEY);
					} catch(_) {}
				}

				try {
					await cacache.verify(CACHE_ROOT_DIR);
				} catch(_) {}
			})();

			runInDir(cwd, () => subscriptions.add(downloadOrBuildPurescript(options).subscribe({
				next(val) {
					observer.next(val);
				},
				async error(err) {
					await cacheCleaning;
					observer.error(err);
				},
				async complete() {
					observer.next({id: 'write-cache'});

					try {
						await cacheCleaning;
						const binStat = await promisify(fs.lstat)(binPath);
						const cacheStream = cacache.put.stream(CACHE_ROOT_DIR, CACHE_KEY, {
							size: binStat.size,
							metadata: {
								id: cacheId,
								mode: binStat.mode
							}
						});
						await promisify(pump)(
							fs.createReadStream(binPath),
							cacheStream);
					} catch (err) {
						observer.next({
							id: 'write-cache:fail',
							error: addId(err, 'write-cache')
						});
						observer.complete();

						return;
					}

					observer.next({id: 'write-cache:complete'});
					observer.complete();
				}
			})));
		}

		if (options.forceReinstall) {
			main();
			return cancelInstallation;
		}

		const tmpSubscription = downloadOrBuildPurescript(options).subscribe({
			error(err) {
				observer.error(err);
			}
		});

		(async () => {
			const searchCacheValue = {
				id: 'search-cache',
				found: false
			};
			let id;
			let cachePath;
			let binMode;

			try {
				const [info] = await Promise.all([
					cacache.get.info(CACHE_ROOT_DIR, CACHE_KEY),
					(async () => {
						await promisify(setImmediate)();
						tmpSubscription.unsubscribe();
					})(),
					(async () => {
						let binStat;
						try {
							binStat = await promisify(fs.stat)(binPath);

							if (binStat.isDirectory()) {
								const error = new Error(`Tried to create a PureScript binary at ${binPath}, but a directory already exists there.`);

								error.code = 'EISDIR';
								error.path = binPath;
								observer.error(error);
							} else {
								await promisify(fs.unlink)(binPath);
							}
						} catch (err) {
							if (err.code !== 'ENOENT') {
								throw err;
							}
						}
					})()
				]);

				id = info.metadata.id;
				cachePath = info.path;
				binMode = info.metadata.mode;
			} catch (_) {
				if (observer.closed) {
					return;
				}

				observer.next(searchCacheValue);
				main();

				return;
			}

			if (observer.closed) {
				return;
			}

			if (id !== cacheId) {
				observer.next(searchCacheValue);
				main({brokenCacheFound: true});
				return;
			}

			searchCacheValue.found = true;
			searchCacheValue.path = cachePath;
			observer.next(searchCacheValue);
			observer.next({id: 'restore-cache'});

			try {
				await promisify(pump)(
					fs.createReadStream(cachePath),
					fs.createWriteStream(binPath)
				);
				await promisify(fs.chmod)(binPath, binMode);
			} catch (err) {
				observer.next({
					id: 'restore-cache:fail',
					error: addId(err, 'restore-cache')
				});

				main({brokenCacheFound: true});
				return;
			}

			observer.next({id: 'restore-cache:complete'});
			observer.next({id: 'check-binary'});

			try {
				await promisify(execFile)(binPath, ['--version'], {timeout: 8000, ...options});
			} catch (err) {
				observer.next({
					id: 'check-binary:fail',
					error: addId(err, 'check-binary')
				});

				main({brokenCacheFound: true});
				return;
			}

			observer.next({id: 'check-binary:complete'});
			observer.complete();
		})();

		return cancelInstallation;
	});
};

Object.defineProperties(module.exports, {
	cacheKey: {
		enumerable: true,
		value: CACHE_KEY
	},
	cacheRootDir: {
		enumerable: true,
		value: CACHE_ROOT_DIR
	},
	defaultVersion: {
		enumerable: true,
		value: downloadOrBuildPurescript.defaultVersion
	},
	supportedBuildFlags: {
		enumerable: true,
		value: downloadOrBuildPurescript.supportedBuildFlags
	}
});
