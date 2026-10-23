import * as cheerio from 'cheerio';
import BrowserManager from '../core/browser.manager.js';
import { CarrierEnum, TrackingStatusEnum, createTrackingResult } from '../core/schemas.js';
import { USPS_SELECTORS } from '../core/selectors.js';
import { getLogger } from '../core/logger.js';

const log = getLogger().tag('USPS');

export class USPSService {
    static isValid(tn) {
        if (!tn || typeof tn !== 'string') return false;
        const clean = tn.replace(/\s+/g, '').toUpperCase();
        const isDomestic = /^(9[1-5]\d{20,24}|9\d{21})$/.test(clean);
        const isInternational = /^[A-Z]{2}\d{9}US$/.test(clean);
        const isRoutingPrefixed = /^(420\d{5})?9\d{21,23}$/.test(clean);
        const isStandard20to24 = /^\d{20,24}$/.test(clean);
        return isDomestic || isInternational || isRoutingPrefixed || isStandard20to24;
    }

    static normalizeStatus(text) {
        if (!text) return TrackingStatusEnum.UNKNOWN;
        const h = String(text).toUpperCase();
        if (h.includes('DELIVERED')) return TrackingStatusEnum.DELIVERED;
        if (h.includes('OUT FOR DELIVERY')) return TrackingStatusEnum.OUT_FOR_DELIVERY;
        if (h.includes('IN TRANSIT') || h.includes('MOVING THROUGH') || h.includes('ARRIVED') || h.includes('DEPARTED')) return TrackingStatusEnum.IN_TRANSIT;
        if (['ACCEPTED', 'PRE-SHIPMENT', 'LABEL CREATED', 'SHIPPING LABEL CREATED'].some(k => h.includes(k))) return TrackingStatusEnum.ACCEPTED;
        if (['NOT AVAILABLE', 'ALERT', 'EXCEPTION', 'CANNOT FIND', 'NOT FOUND'].some(k => h.includes(k))) return TrackingStatusEnum.EXCEPTION;
        return h;
    }

    static cleanTrackingNumber(tn) {
        if (!tn) return '';
        return String(tn).replace(/[\s-]+/g, '').trim();
    }

    static async track(trackingNumber, options = {}) {
        const results = await this.trackBatch([trackingNumber], options);
        return results[0] || createTrackingResult({
            trackingNumber,
            carrier: CarrierEnum.USPS,
            status: TrackingStatusEnum.ERROR,
            statusDescription: 'No result returned',
            delivered: false
        });
    }

    /**
     * Batch tracking for USPS with profile rotation (same strategy as FedEx).
     *
     * Strategy:
     *   - 2 attempts per profile (retains cookies, Akamai tokens across retry 1 & 2)
     *   - After 2 failed attempts: nuke the browser → fresh Camoufox fingerprint + fresh Decodo IP
     *   - Each profile gets a unique Decodo sticky session ID
     *   - Akamai sensor detection, meta-refresh handling, and DOM extraction intact
     */
    static async trackBatch(trackingNumbers, options = {}) {
        const cleanTns = trackingNumbers
            .map(tn => this.cleanTrackingNumber(tn))
            .filter(Boolean);

        if (!cleanTns.length) return [];

        const maxRetries = options.maxRetries !== undefined ? Number(options.maxRetries) : BrowserManager.getConfig().maxTrackingRetries;
        const ATTEMPTS_PER_PROFILE = 2;
        const totalAttempts = maxRetries + 1; // first attempt + retries

        let finalResults = [];
        let attemptsDone = 0;

        // ── Outer loop: each iteration = one browser profile ──
        while (attemptsDone < totalAttempts) {
            const session = `us${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            const profileNum = Math.floor(attemptsDone / ATTEMPTS_PER_PROFILE) + 1;
            const batchSize = Math.min(ATTEMPTS_PER_PROFILE, totalAttempts - attemptsDone);

            log.info(`━━━ Profile ${profileNum} ━━━ session: ${session} | ${batchSize} attempt(s)`);

            try {
                finalResults = await BrowserManager.withTab('USPS', async (page) => {
                    let results = [];

                    for (let i = 0; i < batchSize; i++) {
                        attemptsDone++;
                        const isRetryInProfile = i > 0;

                        if (isRetryInProfile) {
                            log.info(`[Attempt ${attemptsDone}/${totalAttempts}] Retrying in same profile...`);
                            try { await page.goto('about:blank'); } catch (_) {}
                            await new Promise(r => setTimeout(r, 2000));
                        }

                        const tLabels = cleanTns.join(',');
                        const url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tLabels}`;
                        log.info(`[Attempt ${attemptsDone}/${totalAttempts}] Tracking ${cleanTns.length} number(s): ${url}`);

                        let isOutageRedirect = false;
                        const handleResponse = (resp) => {
                            const u = resp.url();
                            if (u.includes('anyapp_outage_apology')) {
                                isOutageRedirect = true;
                            }
                        };
                        page.on('response', handleResponse);

                        let respStatus = null;
                        try {
                            const resp = await page.goto(url, {
                                waitUntil: 'domcontentloaded',
                                timeout: Math.max(35000, cleanTns.length * 2000)
                            });
                            if (resp) respStatus = resp.status();
                        } catch (err) {
                            log.warn(`Navigation warning: ${err.message}`);
                        }

                        // If immediate 401/403 or Access Denied — bail this profile
                        if (respStatus === 401 || respStatus === 403) {
                            log.warn(`Received HTTP ${respStatus} from Akamai Edge. Profile ${profileNum} blocked.`);
                            page.off('response', handleResponse);
                            break;
                        }

                        // ── Diagnostic: page state after navigation ──
                        try {
                            const pageTitle = await page.title();
                            const pageUrl = page.url();
                            log.info(`[Attempt ${attemptsDone}] Page → title: "${pageTitle}" | url: ${pageUrl}`);
                        } catch (_) {}

                        let startWait = Date.now();
                        const maxWaitMs = Math.max(35000, cleanTns.length * 3000);
                        let htmlContent = '';
                        let lastCardCount = 0;
                        let stableCountTicks = 0;
                        let hasNavigatedToSpa = false;

                        while ((Date.now() - startWait) < maxWaitMs) {
                            if (page.isClosed()) break;

                            // Check if burned IP redirected to outage apology
                            if (isOutageRedirect) {
                                log.warn(`Flagged IP redirected to outage apology. Profile ${profileNum} burned.`);
                                break;
                            }

                            const pageTitle = await page.title().catch(() => '');
                            if (pageTitle.includes('Access Denied')) {
                                log.warn(`Access Denied encountered on profile ${profileNum}.`);
                                break;
                            }
                            if (pageTitle.includes('service is currently unavailable')) {
                                log.warn(`Outage apology page on profile ${profileNum}.`);
                                break;
                            }

                            // 1. Detect if Akamai interstitial challenge is currently executing
                            const challengeState = await page.evaluate(() => {
                                const isBlank = document.title === '' && document.body && document.body.innerText.trim().length === 0;
                                let hasSensorToken = false;
                                try {
                                    for (let k of Object.keys(localStorage)) {
                                        if (localStorage.getItem(k)?.length > 50) {
                                            hasSensorToken = true;
                                            break;
                                        }
                                    }
                                } catch (_) {}
                                return { isBlank, hasSensorToken };
                            }).catch(() => ({ isBlank: false, hasSensorToken: false }));

                            if (challengeState.isBlank) {
                                const elapsedChallenge = Date.now() - startWait;

                                // If sensor has solved and written token, navigate to tracking SPA once
                                if (challengeState.hasSensorToken && !hasNavigatedToSpa) {
                                    hasNavigatedToSpa = true;
                                    log.info(`Akamai sensor challenge solved. Navigating to tracking SPA...`);
                                    await new Promise(r => setTimeout(r, 1000));
                                    // Reset startWait so SPA has full render window
                                    startWait = Date.now();
                                    await page.goto(`https://tools.usps.com/tracking/?tLabels=${tLabels}`, {
                                        waitUntil: 'domcontentloaded',
                                        timeout: 25000
                                    }).catch(err => log.warn(`SPA navigation warning: ${err.message}`));
                                    await new Promise(r => setTimeout(r, 1500));
                                    continue;
                                }

                                // Check if Akamai meta-refresh challenge tag is present
                                if (elapsedChallenge > 5500 && !page.url().includes('bm-verify')) {
                                    const refreshUrl = await page.evaluate(() => {
                                        const meta = document.querySelector('meta[http-equiv="refresh"]');
                                        if (!meta) return null;
                                        const match = (meta.content || '').match(/URL=['"]?([^'"]+)['"]?/i);
                                        return match ? match[1] : null;
                                    }).catch(() => null);

                                    if (refreshUrl) {
                                        log.info(`Following Akamai challenge meta-refresh: ${refreshUrl}`);
                                        await page.goto(new URL(refreshUrl, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
                                    }
                                }

                                await new Promise(r => setTimeout(r, 1000));
                                continue;
                            }

                            // 2. Count rendered tracking cards in the DOM
                            const currentCardCount = await page.$$eval(
                                USPS_SELECTORS.CARD_CONTAINERS,
                                els => els.length
                            ).catch(() => 0);

                            // If all requested cards have rendered, wait briefly for text binding and extract
                            if (currentCardCount >= cleanTns.length) {
                                await new Promise(r => setTimeout(r, 1500));
                                htmlContent = await page.content();
                                break;
                            }

                            // 3. Stabilization check
                            if (currentCardCount > 0 && currentCardCount === lastCardCount) {
                                stableCountTicks++;
                                if (stableCountTicks >= 3) {
                                    htmlContent = await page.content();
                                    break;
                                }
                            } else {
                                lastCardCount = currentCardCount;
                                stableCountTicks = 0;
                            }

                            // 4. Check for single-number redirect or error banners if 0 cards rendered after 6s
                            const elapsed = Date.now() - startWait;
                            if (currentCardCount === 0 && elapsed > 6000) {
                                const hasBanners = await page.$$eval(USPS_SELECTORS.BANNER_CHECK, els => els.length).catch(() => 0);
                                if (hasBanners > 0) {
                                    await new Promise(r => setTimeout(r, 1500));
                                    htmlContent = await page.content();
                                    break;
                                }
                            }

                            // 5. Fail-fast stall detection: if 0 cards rendered after 28s
                            if (currentCardCount === 0 && elapsed > 28000) {
                                log.warn(`Attempt ${attemptsDone} stalled with 0 cards after 28s.`);
                                break;
                            }

                            await new Promise(r => setTimeout(r, 1000));
                        }

                        page.off('response', handleResponse);

                        if (!htmlContent && !page.isClosed()) {
                            try {
                                htmlContent = await page.content();
                            } catch (_) {}
                        }

                        const attemptResults = this._extractTrackingResults(htmlContent, cleanTns);
                        if (attemptResults && attemptResults.length > 0) {
                            const unresolved = attemptResults.filter(r => r.status === TrackingStatusEnum.UNKNOWN || r.status === TrackingStatusEnum.ERROR);
                            if (unresolved.length === 0) {
                                return attemptResults;
                            }
                            results = attemptResults; // keep best results so far
                        }
                    }

                    return results;
                }, { session });
            } catch (err) {
                log.error(`Profile ${profileNum} error: ${err.message}`);
                finalResults = cleanTns.map(tn => createTrackingResult({
                    trackingNumber: tn,
                    carrier: CarrierEnum.USPS,
                    status: TrackingStatusEnum.ERROR,
                    statusDescription: `Profile error: ${err.message}`,
                    delivered: false
                }));
            }

            // Check if all resolved
            const unresolvedCount = (finalResults || []).filter(r => r.status === TrackingStatusEnum.UNKNOWN || r.status === TrackingStatusEnum.ERROR).length;
            if (finalResults?.length && unresolvedCount === 0) break;

            // ── Rotate: nuke browser for fresh Camoufox fingerprint + new IP ──
            if (attemptsDone < totalAttempts) {
                log.info(`[Profile ${profileNum}] Failed — recycling browser for fresh fingerprint + IP...`);
                await BrowserManager.closeAll();
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!finalResults || !finalResults.length) {
            finalResults = cleanTns.map(tn => createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.USPS,
                status: TrackingStatusEnum.UNKNOWN,
                statusDescription: 'USPS service unavailable or blocked across all profiles',
                delivered: false
            }));
        }

        for (const r of finalResults) {
            if (r.status === TrackingStatusEnum.DELIVERED) {
                log.success(`${r.trackingNumber} -> ${r.status} (${r.statusDescription})`);
            } else if (r.status === TrackingStatusEnum.UNKNOWN || r.status === TrackingStatusEnum.ERROR) {
                log.warn(`${r.trackingNumber} -> ${r.status} (${r.statusDescription})`);
            } else {
                log.info(`${r.trackingNumber} -> ${r.status} (${r.statusDescription})`);
            }
        }
        return finalResults;
    }

    static _extractTrackingResults(html, requestedTns) {
        if (!html) {
            return requestedTns.map(tn => createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.USPS,
                status: TrackingStatusEnum.UNKNOWN,
                statusDescription: 'No HTML content received from USPS',
                delivered: false
            }));
        }

        const $ = cheerio.load(html);
        const resultMap = new Map();

        // 1. Process standard cards (.track-bar-container, .product_summary)
        $(USPS_SELECTORS.CARD_CONTAINERS).each((_, elem) => {
            const container = $(elem);

            const tnRaw = container.find(USPS_SELECTORS.TRACKING_NUMBER).text().trim();
            const tn = this.cleanTrackingNumber(tnRaw) || (requestedTns.length === 1 ? requestedTns[0] : '');
            if (!tn) return;

            // Extract status
            const tbStatus = container.find('.tb-step.current-step .tb-status').first().text().trim() ||
                             container.find('.tb-status').first().text().trim() ||
                             container.find('.delivery_status, .status').first().text().trim();

            const bannerHdr = container.find(USPS_SELECTORS.BANNER_HEADER).first().text().trim();

            // Extract clean details (prioritize banner-content / official summary)
            const bannerContent = container.find(USPS_SELECTORS.BANNER_CONTENT).first().text().trim();
            const currentStepDetail = container.find('.tb-step.current-step .tb-status-detail').first().text().trim();
            const fallbackDetail = container.find('.tb-status-detail').first().text().trim();

            // Extract location
            const currentLocation = container.find('.tb-step.current-step .tb-location').first().text().trim() ||
                                    container.find('.tb-location').first().text().trim();

            // Extract date (first line only to avoid concatenating history)
            const dateElem = container.find(USPS_SELECTORS.DATE).first();
            const rawDate = dateElem.text().trim();
            const date = rawDate ? rawDate.split('\n')[0].trim() : null;

            const resolvedStatus = tbStatus || (bannerHdr && bannerHdr !== 'Latest Update' ? bannerHdr : '') || currentStepDetail || 'Status Available';
            const statusDesc = currentStepDetail || tbStatus || (bannerHdr && bannerHdr !== 'Latest Update' ? bannerHdr : '') || 'Status Available';

            let details = null;
            if (bannerContent) {
                details = bannerContent;
            } else if (currentStepDetail && currentLocation) {
                details = `${currentStepDetail} - ${currentLocation}`;
            } else if (currentStepDetail) {
                details = currentStepDetail;
            } else if (fallbackDetail) {
                details = fallbackDetail;
            } else if (currentLocation) {
                details = currentLocation;
            }

            const isDeliv = `${resolvedStatus} ${statusDesc} ${bannerContent || ''}`.toUpperCase().includes('DELIVERED');

            resultMap.set(tn, createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.USPS,
                status: this.normalizeStatus(resolvedStatus),
                statusDescription: statusDesc,
                details,
                expectedDelivery: date || null,
                delivered: isDeliv
            }));
        });

        // 2. Fallback for single tracking card or direct banner page
        if (resultMap.size === 0 && requestedTns.length === 1) {
            const singleTn = requestedTns[0];
            const statusEl = $(USPS_SELECTORS.BANNER_CHECK).first();
            if (statusEl.length) {
                const statusText = statusEl.text().trim();
                const bannerContent = $(USPS_SELECTORS.BANNER_CONTENT).first().text().trim();
                const detailText = $(USPS_SELECTORS.STATUS_DETAIL).first().text().trim();

                const resolvedStatus = statusText || detailText || 'Status Available';
                const statusDesc = detailText || statusText || 'Status Available';
                const isDeliv = `${resolvedStatus} ${statusDesc} ${bannerContent}`.toUpperCase().includes('DELIVERED');

                resultMap.set(singleTn, createTrackingResult({
                    trackingNumber: singleTn,
                    carrier: CarrierEnum.USPS,
                    status: this.normalizeStatus(resolvedStatus),
                    statusDescription: statusDesc,
                    details: bannerContent || detailText || null,
                    delivered: isDeliv
                }));
            }
        }

        // 3. Return results in exact order of requested tracking numbers
        return requestedTns.map(tn => {
            const clean = this.cleanTrackingNumber(tn);
            if (resultMap.has(clean)) {
                return resultMap.get(clean);
            }
            return createTrackingResult({
                trackingNumber: clean,
                carrier: CarrierEnum.USPS,
                status: TrackingStatusEnum.UNKNOWN,
                statusDescription: 'No tracking information returned by USPS',
                delivered: false
            });
        });
    }
}

export default USPSService;
