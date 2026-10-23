/**
 * zamar-tracker — Self-contained shipment tracking module.
 *
 * Usage:
 *   import { initialize, track, trackBatch, shutdown } from './tracker/index.js';
 *
 *   // 1. Configure and boot the browser (call once at app startup)
 *   await initialize({
 *       headless: true,                // default false
 *       proxy: 'http://...',           // global proxy (optional)
 *       uspsProxy: 'http://...',       // USPS-specific proxy (optional)
 *       maxTrackingRetries: 4,         // per-carrier retry ceiling (optional)
 *       camoufoxBinDir: '/path/to/.camoufox-bin'  // optional
 *   });
 *
 *   // 2. Track a single package (carrier auto-detected or explicit)
 *   const result = await track('1Z999AA10123456784');
 *   const result2 = await track('9400111899223456789012', 'USPS');
 *
 *   // 3. Track many packages in one call (mixed carriers OK)
 *   const results = await trackBatch([
 *       '1Z999AA10123456784',
 *       '9400111899223456789012',
 *       '123456789012'
 *   ]);
 *
 *   // 4. Shut down the browser when done
 *   await shutdown();
 *
 * Peer dependencies (must be installed in the consuming project):
 *   - camoufox-js
 *   - cheerio
 *   - playwright
 */

import BrowserManager from './core/browser.manager.js';
import TrackerService from './tracker.service.js';
import { detectCarrier, cleanTrackingNumber } from './tracker.service.js';
import { setLogger, getLogger } from './core/logger.js';

// Re-export enums and factory so consumers can inspect / construct results
export { CarrierEnum, TrackingStatusEnum, createTrackingResult } from './core/schemas.js';
export { detectCarrier, cleanTrackingNumber };
export { startIdleMouse } from './core/mouse.util.js';

/**
 * Initialize the tracking module.
 * Launches the Camoufox browser and applies configuration.
 *
 * @param {Object} opts
 * @param {boolean}  [opts.headless=false]           Run browser headless
 * @param {string}   [opts.proxy]                    Global proxy URL
 * @param {string}   [opts.uspsProxy]                USPS-specific proxy URL
 * @param {string}   [opts.httpProxy]                Fallback HTTP proxy URL
 * @param {number}   [opts.maxTrackingRetries=4]     Max retries per carrier
 * @param {string}   [opts.camoufoxBinDir]           Path to .camoufox-bin directory
 * @param {Object}   [opts.logger]                   Custom logger instance (must have .tag(), .info(), .warn(), .error(), .success())
 */
export async function initialize(opts = {}) {
    if (opts.logger) {
        setLogger(opts.logger);
    }
    BrowserManager.configure(opts);
    await BrowserManager.initialize();
}

/**
 * Track a single shipment.
 *
 * @param {string}  trackingNumber   The tracking number
 * @param {string}  [carrier]        Force a carrier ('FEDEX' | 'UPS' | 'USPS'). Auto-detected if omitted.
 * @param {Object}  [options]        Extra options (e.g. { maxRetries, proxy })
 * @returns {Promise<Object>}        TrackingResult
 */
export async function track(trackingNumber, carrier = null, options = {}) {
    return TrackerService.track(trackingNumber, carrier, options);
}

/**
 * Track multiple shipments in one call.
 * Tracking numbers can be mixed carriers — they are auto-grouped.
 *
 * @param {string[]} trackingNumbers  Array of tracking numbers
 * @param {string}   [carrier]        Force all to a single carrier (optional)
 * @param {Object}   [options]        Extra options (e.g. { maxRetries })
 * @returns {Promise<Object[]>}       Array of TrackingResult in same order as input
 */
export async function trackBatch(trackingNumbers, carrier = null, options = {}) {
    return TrackerService.trackBatch(trackingNumbers, carrier, options);
}

/**
 * Gracefully shut down the browser.
 * Call this when your application is exiting.
 */
export async function shutdown() {
    await BrowserManager.closeAll();
}

/**
 * List supported carrier names.
 * @returns {string[]}
 */
export function listProviders() {
    return TrackerService.listProviders();
}

// Default export for convenience
export default {
    initialize,
    track,
    trackBatch,
    shutdown,
    listProviders,
    detectCarrier,
    cleanTrackingNumber
};
