import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from './logger.js';
import { startIdleMouse } from './mouse.util.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDefaultCamoufoxBinDir() {
    const candidates = [
        process.env.CAMOUFOX_INSTALL_DIR,
        path.resolve(process.cwd(), '.camoufox-bin'),
        path.resolve(__dirname, '..', '..', '.camoufox-bin'),
        path.resolve(__dirname, '..', '.camoufox-bin')
    ].filter(Boolean);

    for (const cand of candidates) {
        if (fs.existsSync(cand)) return cand;
    }
    return path.resolve(process.cwd(), '.camoufox-bin');
}

const log = getLogger().tag('BrowserManager');

function maskProxyUrl(proxyStr) {
    if (!proxyStr) return 'None (direct)';
    try {
        const u = new URL(proxyStr);
        const user = u.username ? decodeURIComponent(u.username) : '';
        const auth = user ? `${user}:***@` : '';
        return `${u.protocol}//${auth}${u.host}`;
    } catch (_) {
        return 'configured';
    }
}

// WebGL context provider fallback for headless/virtualized Windows environments without physical GPU
const WEBGL_INIT_SCRIPT = `
(() => {
    try {
        const origGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
            const ctx = origGetContext.apply(this, [type, ...args]);
            if (ctx) return ctx;

            if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
                const glMock = {
                    canvas: this,
                    drawingBufferWidth: this.width || 300,
                    drawingBufferHeight: this.height || 150,
                    VENDOR: 7936,
                    RENDERER: 7937,
                    VERSION: 7938,
                    SHADING_LANGUAGE_VERSION: 35724,
                    MAX_TEXTURE_SIZE: 16384,
                    MAX_VIEWPORT_DIMS: new Int32Array([16384, 16384]),
                    MAX_VERTEX_ATTRIBS: 16,
                    MAX_VERTEX_UNIFORM_VECTORS: 1024,
                    MAX_VARYING_VECTORS: 30,
                    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
                    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
                    MAX_TEXTURE_IMAGE_UNITS: 16,
                    MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
                    MAX_RENDERBUFFER_SIZE: 16384,
                    getParameter: function(p) {
                        if (p === 7936) return 'Mozilla';
                        if (p === 7937) return 'Mozilla';
                        if (p === 7938) return 'WebGL 1.0';
                        if (p === 35724) return 'WebGL GLSL ES 1.0';
                        if (p === 37445) return 'Google Inc. (NVIDIA)';
                        if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11-30.0.14.7212)';
                        if (p === 3379) return 16384;
                        if (p === 3386) return new Int32Array([16384, 16384]);
                        if (p === 3408) return 4;
                        if (p === 3410 || p === 3411 || p === 3412 || p === 3413) return 8;
                        if (p === 3414) return 24;
                        if (p === 3415) return 8;
                        return 0;
                    },
                    getExtension: function(name) {
                        if (name === 'WEBGL_debug_renderer_info') {
                            return {
                                UNMASKED_VENDOR_WEBGL: 37445,
                                UNMASKED_RENDERER_WEBGL: 37446
                            };
                        }
                        if (name === 'WEBGL_lose_context') {
                            return {
                                loseContext: () => {},
                                restoreContext: () => {}
                            };
                        }
                        return null;
                    },
                    getSupportedExtensions: function() {
                        return [
                            'ANGLE_instanced_arrays',
                            'EXT_blend_minmax',
                            'EXT_color_buffer_half_float',
                            'EXT_float_blend',
                            'EXT_sRGB',
                            'EXT_texture_filter_anisotropic',
                            'OES_element_index_uint',
                            'OES_standard_derivatives',
                            'OES_texture_float',
                            'OES_texture_float_linear',
                            'OES_texture_half_float',
                            'OES_texture_half_float_linear',
                            'OES_vertex_array_object',
                            'WEBGL_color_buffer_float',
                            'WEBGL_compressed_texture_s3tc',
                            'WEBGL_debug_renderer_info',
                            'WEBGL_debug_shaders',
                            'WEBGL_depth_texture',
                            'WEBGL_draw_buffers',
                            'WEBGL_lose_context'
                        ];
                    },
                    getShaderPrecisionFormat: function() {
                        return { rangeMin: 127, rangeMax: 127, precision: 23 };
                    },
                    createBuffer: () => ({}),
                    bindBuffer: () => {},
                    bufferData: () => {},
                    createShader: () => ({}),
                    shaderSource: () => {},
                    compileShader: () => {},
                    getShaderParameter: () => true,
                    getShaderInfoLog: () => '',
                    createProgram: () => ({}),
                    attachShader: () => {},
                    linkProgram: () => {},
                    getProgramParameter: () => true,
                    getProgramInfoLog: () => '',
                    useProgram: () => {},
                    getAttribLocation: () => 0,
                    enableVertexAttribArray: () => {},
                    vertexAttribPointer: () => {},
                    drawArrays: () => {},
                    clear: () => {},
                    clearColor: () => {},
                    viewport: () => {},
                    readPixels: (x, y, w, h, format, type, pixels) => {
                        if (pixels && pixels.fill) pixels.fill(128);
                    }
                };
                return glMock;
            }
            return ctx;
        };
    } catch (_) {}
})();
`;

/**
 * Manages a single Camoufox browser lifecycle.
 *
 * Configuration is injected at module-init time via `BrowserManager.configure()`.
 * If not configured, sensible defaults are used.
 */
class BrowserManager {
    static _instance = null;
    static _launchingPromise = null;
    static _sessionCount = 0;
    static _RECYCLE_THRESHOLD = 50;

    /** Runtime config — populated by configure() */
    static _config = {
        headless: false,
        proxy: null,
        uspsProxy: null,
        httpProxy: null,
        maxTrackingRetries: 4,
        camoufoxBinDir: resolveDefaultCamoufoxBinDir()
    };

    /**
     * Merge user-supplied settings into the runtime config.
     * Call this once before `initialize()`.
     */
    static configure(opts = {}) {
        if (opts.headless !== undefined) this._config.headless = opts.headless;
        if (opts.proxy !== undefined) this._config.proxy = opts.proxy;
        if (opts.uspsProxy !== undefined) this._config.uspsProxy = opts.uspsProxy;
        if (opts.httpProxy !== undefined) this._config.httpProxy = opts.httpProxy;
        if (opts.maxTrackingRetries !== undefined) this._config.maxTrackingRetries = Number(opts.maxTrackingRetries);
        if (opts.camoufoxBinDir !== undefined) this._config.camoufoxBinDir = opts.camoufoxBinDir;

        log.info('Proxy configuration loaded:');
        log.info(`  • Global PROXY : ${maskProxyUrl(this._config.proxy)}`);
        log.info(`  • USPS_PROXY   : ${maskProxyUrl(this._config.uspsProxy)}`);
        log.info(`  • HTTP_PROXY   : ${maskProxyUrl(this._config.httpProxy)}`);
    }

    static getConfig() {
        return { ...this._config };
    }

    static getProxyForCarrier(carrier) {
        const normalized = carrier ? String(carrier).toUpperCase().trim() : null;
        if (normalized === 'USPS' && this._config.uspsProxy) {
            return this._config.uspsProxy;
        }
        if (this._config.proxy) {
            return this._config.proxy;
        }
        if (this._config.httpProxy) {
            return this._config.httpProxy;
        }
        return null;
    }

    /**
     * Parse and format proxy string into Playwright context proxy object.
     * Automatically applies Decodo US country targeting and sticky session parameters.
     */
    static parseProxyConfig(carrier, options = {}) {
        const rawProxy = options.proxy || this.getProxyForCarrier(carrier);
        if (!rawProxy) return null;

        try {
            const u = new URL(rawProxy);
            let username = decodeURIComponent(u.username || '');
            let password = decodeURIComponent(u.password || '');

            // For Decodo proxies, ensure country=us and sticky session are present for IP consistency
            if (rawProxy.includes('decodo.com')) {
                const session = options.session || Math.floor(Math.random() * 89999) + 10000;
                if (!username.startsWith('user-')) {
                    username = `user-${username}`;
                }
                if (!username.includes('-country-')) {
                    username = `${username}-country-us`;
                }
                // Replace existing session or add one for fresh exit IP (avoid matching -sessionduration-)
                if (username.match(/-session-(?!duration)[\w-]+/)) {
                    username = username.replace(/-session-(?!duration)[\w-]+/, `-session-${session}`);
                } else {
                    username = `${username}-session-${session}`;
                }
                if (options.session) {
                    log.info(`[Decodo] Rotated session -> ${session}`);
                }
                if (u.hostname === 'gate.decodo.com' && (!u.port || u.port === '10001')) {
                    u.port = '7000';
                }
            }

            // For SOAX proxies, allow session rotation for fresh exit IP
            if (rawProxy.includes('soax.com') && options.session) {
                if (username.includes('session-')) {
                    username = username.replace(/session-\w+/, `session-${options.session}`);
                } else {
                    username = `${username}-session-${options.session}`;
                }
                log.info(`[SOAX] Rotated session -> ${options.session}`);
            }

            const protocol = u.protocol === 'https:' ? 'http:' : u.protocol;
            return {
                server: `${protocol}//${u.host}`,
                username: username || undefined,
                password: password || undefined
            };
        } catch (err) {
            log.warn(`Failed to parse proxy '${rawProxy}': ${err.message}`);
            return null;
        }
    }

    static async initialize() {
        // Ensure Camoufox binary path is set before import
        if (!process.env.CAMOUFOX_INSTALL_DIR) {
            process.env.CAMOUFOX_INSTALL_DIR = this._config.camoufoxBinDir;
        }
        log.info(`Pre-warming Camoufox instance (Headless: ${this._config.headless})...`);
        return await this.getBrowser();
    }

    static async getBrowser() {
        if (this._instance && this._instance.isConnected()) {
            return this._instance;
        }

        if (this._launchingPromise) {
            return await this._launchingPromise;
        }

        this._launchingPromise = (async () => {
            try {
                log.info(`Launching Camoufox (Headless: ${this._config.headless})...`);
                const { Camoufox } = await import('camoufox-js');

                const launchOpts = {
                    headless: this._config.headless,
                    humanize: true,
                    geoip: false,
                    os: 'windows'
                };

                const browser = await Camoufox(launchOpts);
                this._instance = browser;
                log.success(`Camoufox instance online (Headless: ${this._config.headless}).`);
                return browser;
            } finally {
                this._launchingPromise = null;
            }
        })();

        return await this._launchingPromise;
    }

    /**
     * Create an isolated browser context and page.
     * Proxies and SSL settings are applied cleanly at context level.
     */
    static async createContextAndPage(carrier, options = {}) {
        const browser = await this.getBrowser();
        const proxyConfig = this.parseProxyConfig(carrier, options);

        const contextOpts = {
            viewport: { width: 1280, height: 800 },
            ignoreHTTPSErrors: true,
            locale: 'en-US',
            timezoneId: 'America/New_York'
        };

        if (proxyConfig) {
            contextOpts.proxy = proxyConfig;
            log.info(`[${carrier || 'DEFAULT'}] Tab proxy configured -> server: ${proxyConfig.server} (user: ${proxyConfig.username || 'anonymous'})`);
        } else {
            log.info(`[${carrier || 'DEFAULT'}] Tab running without proxy (direct connection)`);
        }

        const context = await browser.newContext(contextOpts);
        // await context.addInitScript(WEBGL_INIT_SCRIPT);
        const page = await context.newPage();

        return { context, page };
    }

    static startIdleMouse(page, options = {}) {
        return startIdleMouse(page, options);
    }

    static async withTab(carrier, fn, options = {}) {
        const { context, page } = await this.createContextAndPage(carrier, options);
        this._sessionCount += 1;

        // Automatically start gentle human-like idle mouse motion unless explicitly disabled
        const stopIdleMouse = options.idleMouse !== false
            ? startIdleMouse(page, options.idleMouseOptions)
            : null;

        try {
            return await fn(page, context);
        } finally {
            try {
                if (stopIdleMouse) stopIdleMouse();
            } catch (_) { }
            try {
                if (!page.isClosed()) {
                    await page.close();
                }
            } catch (_) { }
            try {
                await context.close();
            } catch (_) { }

            if (this._sessionCount >= this._RECYCLE_THRESHOLD) {
                log.info(`Reached ${this._sessionCount} tab sessions. Recycling browser instance...`);
                this._sessionCount = 0;
                this.closeAll().catch(err => log.error('Recycle error:', err));
            }
        }
    }

    static async closeAll() {
        log.info('Closing Camoufox instance...');
        if (this._instance) {
            try {
                if (this._instance.isConnected()) {
                    await this._instance.close();
                }
            } catch (err) {
                log.warn(`Error closing browser: ${err.message}`);
            }
            this._instance = null;
        }
        log.info('Camoufox closed.');
    }
}

export { BrowserManager };
export default BrowserManager;
