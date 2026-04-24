// Default (desktop) asset reader — resolves `file://` URLs via bare-fs.
// Used for macOS / Linux / Windows builds where `import.meta.asset()` yields
// real filesystem paths.

import fs from 'bare-fs'
import { fileURLToPath } from 'bare-url'

/**
 * @param {string} asset_url
 * @returns {Buffer}
 */
export function read_asset(asset_url) {
  return fs.readFileSync(fileURLToPath(new URL(asset_url)))
}
