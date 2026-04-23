// Android asset reader — reads from the packed bundle via the module's
// bundle-aware protocol. `import.meta.asset()` yields `bare:/app.bundle/…`
// URLs on Android, which bare-fs can't resolve.

import Module from 'bare-module';

// The running module's protocol is patched by bare-module when the bundle is
// loaded, so `.read(url)` transparently serves both `bare:/` bundle URLs and
// `file://` URLs if any slip through.
const self_module = Module.cache[import.meta.url];

/**
 * @param {string} asset_url
 * @returns {Buffer}
 */
export function read_asset (asset_url) {
	return self_module._protocol.read(new URL(asset_url));
}
