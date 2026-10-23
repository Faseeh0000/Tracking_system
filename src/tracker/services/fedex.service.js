import BrowserManager from '../core/browser.manager.js';
import { CarrierEnum, TrackingStatusEnum, createTrackingResult } from '../core/schemas.js';
import { FEDEX_SELECTORS } from '../core/selectors.js';
import { getLogger } from '../core/logger.js';

const log = getLogger().tag('FedEx');

export class FedExService {
    static isValid(tn) {
        if (!tn || typeof tn !== 'string') return false;
        const clean = tn.replace(/\s+/g, '');
        return /^\d{10,34}$/.test(clean);
    }

    static normalizeStatus(text) {
        if (!text) return TrackingStatusEnum.UNKNOWN;
        const s = String(text).toUpperCase();
        if ((s.includes('DELIVERED') || s.includes('SIGNED FOR BY') || s.includes('DELIVERED AT')) && !s.includes('OUT FOR DELIVERY')) {
            return TrackingStatusEnum.DELIVERED;
        }
        if (s.includes('OUT FOR DELIVERY')) {
            return TrackingStatusEnum.OUT_FOR_DELIVERY;
        }
        if (['ON THE WAY', 'IN TRANSIT', 'DEPARTED', 'ARRIVED', 'WE HAVE YOUR PACKAGE', 'PICKED UP'].some(k => s.includes(k))) {
            return TrackingStatusEnum.IN_TRANSIT;
        }
        if (['LABEL CREATED', 'SHIPMENT INFORMATION SENT', 'ORDER PROCESSED'].some(k => s.includes(k))) {
            return TrackingStatusEnum.ACCEPTED;
        }
        if (['INVALID', 'NOT FOUND', 'CANNOT FIND'].some(k => s.includes(k))) {
            return TrackingStatusEnum.INVALID;
        }
        if (['DELAY', 'EXCEPTION', 'ERROR', 'UNABLE'].some(k => s.includes(k))) {
            return TrackingStatusEnum.EXCEPTION;
        }
        return s;
    }

    static async track(trackingNumber, options = {}) {
        const results = await this.trackBatch([trackingNumber], options);
        return results[0] || createTrackingResult({
            trackingNumber,
            carrier: CarrierEnum.FEDEX,
            status: TrackingStatusEnum.ERROR,
            statusDescription: 'No result returned',
            delivered: false
        });
    }

    /**
     * Batch tracking for FedEx shipments with profile rotation.
     *
     * Strategy:
     *   - 2 attempts per "profile" (same browser fingerprint + proxy IP)
     *   - After 2 failures: nuke the browser → fresh Camoufox fingerprint
     *     + rotate SOAX session → fresh exit IP
     *   - Repeat until resolved or maxRetries exhausted
     */
    static async trackBatch(trackingNumbers, options = {}) {
        const cleanTns = trackingNumbers
            .map(tn => tn ? String(tn).replace(/[\s-]+/g, '') : '')
            .filter(Boolean);

        if (!cleanTns.length) return [];

        const maxRetries = options.maxRetries !== undefined ? Number(options.maxRetries) : BrowserManager.getConfig().maxTrackingRetries;
        const ATTEMPTS_PER_PROFILE = 2;
        const totalAttempts = maxRetries + 1; // first attempt + retries

        let finalResults = [];
        let attemptsDone = 0;

        // ── Outer loop: each iteration = one browser profile ──
        while (attemptsDone < totalAttempts) {
            const session = `fx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            const profileNum = Math.floor(attemptsDone / ATTEMPTS_PER_PROFILE) + 1;
            const batchSize = Math.min(ATTEMPTS_PER_PROFILE, totalAttempts - attemptsDone);

            log.info(`━━━ Profile ${profileNum} ━━━ session: ${session} | ${batchSize} attempt(s)`);

            try {
                finalResults = await BrowserManager.withTab('FEDEX', async (page) => {
                    let results = [];

                    for (let i = 0; i < batchSize; i++) {
                        attemptsDone++;
                        const isRetryInProfile = i > 0;

                        if (isRetryInProfile) {
                            log.info(`[Attempt ${attemptsDone}/${totalAttempts}] Retrying in same profile...`);
                            try { await page.goto('about:blank'); } catch (_) {}
                            await new Promise(r => setTimeout(r, 2000));
                        }

                        // ── Intercept FedEx track/v2/shipments API response ──
                        let interceptedApiData = null;

                        const handleResponse = async (response) => {
                            try {
                                if (response.url().includes('track/v2/shipments') && response.request().method() === 'POST') {
                                    if (response.status() === 200) {
                                        const json = await response.json();
                                        if (json && typeof json === 'object') {
                                            interceptedApiData = json;
                                        }
                                    }
                                }
                            } catch (_) {}
                        };

                        page.on('response', handleResponse);

                        const trknbrParam = cleanTns.join(',');
                        const targetUrl = `https://www.fedex.com/fedextrack/?trknbr=${trknbrParam}`;
                        log.info(`[Attempt ${attemptsDone}/${totalAttempts}] ${targetUrl}`);

                        try {
                            await page.goto(targetUrl, {
                                waitUntil: 'domcontentloaded',
                                timeout: Math.max(35000, cleanTns.length * 1500)
                            });
                        } catch (err) {
                            log.warn(`Navigation warning: ${err.message}`);
                        }

                        // ── Diagnostic: page state after navigation ──
                        try {
                            const pageTitle = await page.title();
                            const pageUrl = page.url();
                            log.info(`[Attempt ${attemptsDone}] Page → title: "${pageTitle}" | url: ${pageUrl}`);
                        } catch (_) {}

                        // ── Poll for intercepted API response ──
                        const startWait = Date.now();
                        const waitLimitMs = Math.max(15000, cleanTns.length * 1500);

                        while ((Date.now() - startWait) < waitLimitMs) {
                            if (page.isClosed()) break;
                            if (interceptedApiData) break;
                            await new Promise(r => setTimeout(r, 500));
                        }

                        page.off('response', handleResponse);

                        // ── Diagnostic: if no API data, show what page contains ──
                        if (!interceptedApiData) {
                            try {
                                const bodySnippet = await page.evaluate(() => {
                                    const text = document.body?.innerText || '';
                                    return text.substring(0, 500);
                                });
                                log.warn(`[Attempt ${attemptsDone}] No API intercept. Body: ${bodySnippet.replace(/\n/g, ' ').trim() || '(empty)'}`);
                            } catch (_) {
                                log.warn(`[Attempt ${attemptsDone}] No API intercept and could not read page body.`);
                            }
                        }

                        // ── Extract results from API + DOM fallback ──
                        const resultMap = new Map();

                        if (interceptedApiData) {
                            this._extractPackagesFromApi(interceptedApiData, cleanTns, resultMap);
                        }

                        for (const tn of cleanTns) {
                            if (!resultMap.has(tn) || resultMap.get(tn).status === TrackingStatusEnum.UNKNOWN) {
                                try {
                                    const domResult = await this._checkDom(page, tn);
                                    if (domResult && domResult.status !== TrackingStatusEnum.UNKNOWN) {
                                        resultMap.set(tn, domResult);
                                    }
                                } catch (_) {}
                            }
                        }

                        results = cleanTns.map(tn => {
                            return resultMap.get(tn) || createTrackingResult({
                                trackingNumber: tn,
                                carrier: CarrierEnum.FEDEX,
                                status: TrackingStatusEnum.UNKNOWN,
                                statusDescription: 'No tracking information could be extracted from FedEx',
                                delivered: false
                            });
                        });

                        // Check if all resolved
                        const unresolvedCount = results.filter(r => r.status === TrackingStatusEnum.UNKNOWN || r.status === TrackingStatusEnum.ERROR).length;
                        if (unresolvedCount === 0) break;
                    }

                    return results;
                }, { session });
            } catch (err) {
                log.error(`Profile ${profileNum} crashed: ${err.message}`);
                finalResults = cleanTns.map(tn => createTrackingResult({
                    trackingNumber: tn,
                    carrier: CarrierEnum.FEDEX,
                    status: TrackingStatusEnum.ERROR,
                    statusDescription: `Profile error: ${err.message}`,
                    delivered: false
                }));
            }

            // Check if all resolved
            const unresolvedCount = finalResults.filter(r => r.status === TrackingStatusEnum.UNKNOWN || r.status === TrackingStatusEnum.ERROR).length;
            if (unresolvedCount === 0) break;

            // ── Rotate: nuke browser for fresh Camoufox fingerprint + new IP ──
            if (attemptsDone < totalAttempts) {
                log.info(`[Profile ${profileNum}] Failed — recycling browser for fresh fingerprint + IP...`);
                await BrowserManager.closeAll();
                await new Promise(r => setTimeout(r, 2000));
            }
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

    /**
     * Extracts and maps package data from both `output.packages` and `output.completeTrackResults`
     */
    static _extractPackagesFromApi(apiData, requestedTns, resultMap) {
        try {
            // Group raw packages by tracking number
            const packagesByTn = new Map();

            // 1. Check output.packages (standard multi-tracking format)
            const rawPackages = apiData?.output?.packages || [];
            for (const pkg of rawPackages) {
                const tn = (pkg.trackingNbr || pkg.displayTrackingNbr || '').replace(/[\s-]+/g, '');
                if (tn) {
                    if (!packagesByTn.has(tn)) packagesByTn.set(tn, []);
                    packagesByTn.get(tn).push(pkg);
                }
            }

            // 2. Check completeTrackResults (fallback format)
            const completeResults = apiData?.output?.completeTrackResults || [];
            for (const cr of completeResults) {
                const trackResults = cr?.trackResults || [];
                for (const pkg of trackResults) {
                    const tn = (pkg.trackingNumber || pkg.trackingNbr || '').replace(/[\s-]+/g, '');
                    if (tn) {
                        if (!packagesByTn.has(tn)) packagesByTn.set(tn, []);
                        packagesByTn.get(tn).push(pkg);
                    }
                }
            }

            // Also check root packageList if present
            const packageList = apiData?.packageList || [];
            for (const pkg of packageList) {
                const tn = (pkg.trackingNbr || pkg.trackingNumber || '').replace(/[\s-]+/g, '');
                if (tn) {
                    if (!packagesByTn.has(tn)) packagesByTn.set(tn, []);
                    packagesByTn.get(tn).push(pkg);
                }
            }

            // Process each requested tracking number
            for (const tn of requestedTns) {
                const pkgs = packagesByTn.get(tn);
                if (pkgs && pkgs.length > 0) {
                    // If multiple shipments exist for the same tracking number, pick the latest / delivered one
                    const chosen = pkgs.find(p => {
                        const s = (p.keyStatus || p.mainStatus || '').toLowerCase();
                        return s.includes('delivered') || p.delivered === true;
                    }) || pkgs[0];

                    const parsed = this._parsePackageObject(tn, chosen);
                    if (parsed) {
                        resultMap.set(tn, parsed);
                    }
                }
            }
        } catch (e) {
            log.warn(`Error extracting packages from API: ${e.message}`);
        }
    }

    /**
     * Parses an individual FedEx package JSON object into a TrackingResult
     */
    static _parsePackageObject(tn, pkg) {
        try {
            // Check for errors in errorList (e.g. tracking number not found)
            const errorList = pkg.errorList || [];
            if (errorList.length > 0) {
                const firstErr = errorList[0];
                const msg = firstErr.message || 'Tracking number not found';
                const isNotFound = firstErr.code?.includes('NOTFOUND') ||
                                   msg.toLowerCase().includes("can't be found") ||
                                   msg.toLowerCase().includes('not found') ||
                                   msg.toLowerCase().includes('invalid');
                if (isNotFound) {
                    return createTrackingResult({
                        trackingNumber: tn,
                        carrier: CarrierEnum.FEDEX,
                        status: TrackingStatusEnum.INVALID,
                        statusDescription: msg,
                        delivered: false
                    });
                }
            }

            const statusDesc = (
                pkg.keyStatus ||
                pkg.statusWithDetails ||
                pkg.latestStatusDetail?.description ||
                pkg.latestStatusDetail?.statusByLocale ||
                pkg.mainStatus ||
                pkg.shortStatus ||
                (pkg.delivered ? 'Delivered' : pkg.statusActionDesc) ||
                'Status Available'
            );

            const isNotFoundDesc = ['not found', 'no record', "can't find", 'cannot find'].some(k => statusDesc.toLowerCase().includes(k));
            if (isNotFoundDesc) {
                return createTrackingResult({
                    trackingNumber: tn,
                    carrier: CarrierEnum.FEDEX,
                    status: TrackingStatusEnum.INVALID,
                    statusDescription: statusDesc,
                    delivered: false
                });
            }

            const isDelivered = (
                statusDesc.toLowerCase().includes('delivered') ||
                pkg.keyStatus?.toLowerCase() === 'delivered' ||
                pkg.delivered === true
            );

            const resolvedStatus = isDelivered
                ? TrackingStatusEnum.DELIVERED
                : this.normalizeStatus(statusDesc);

            // Details resolution
            let details = null;
            if (pkg.receivedByNm) {
                details = `Signed for by: ${pkg.receivedByNm}`;
            } else if (pkg.statusLocationAddress?.city) {
                const loc = [pkg.statusLocationAddress.city, pkg.statusLocationAddress.stateOrProvinceCode].filter(Boolean).join(', ');
                details = `${statusDesc} - ${loc}`;
            } else if (pkg.statusWithDetails && pkg.statusWithDetails !== statusDesc) {
                details = pkg.statusWithDetails;
            } else if (pkg.latestStatusDetail?.ancillaryDetails?.[0]?.reasonDescription) {
                details = pkg.latestStatusDetail.ancillaryDetails[0].reasonDescription;
            } else if (pkg.deliveryLocationDesc) {
                details = pkg.deliveryLocationDesc;
            }

            // Expected or actual delivery date
            const expDelivery = (
                pkg.displayActDeliveryDateTime ||
                pkg.displayActDeliveryDt ||
                pkg.displayEstDeliveryDateTime ||
                pkg.displayEstDeliveryDt ||
                pkg.actDeliveryDt ||
                pkg.estDeliveryDt ||
                pkg.actualDeliveryDate ||
                null
            );

            return createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.FEDEX,
                status: resolvedStatus,
                statusDescription: statusDesc,
                details,
                expectedDelivery: expDelivery,
                delivered: isDelivered,
                raw: null
            });
        } catch (e) {
            return createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.FEDEX,
                status: TrackingStatusEnum.ERROR,
                statusDescription: `Parsing error: ${e.message}`,
                delivered: false
            });
        }
    }

    static async _checkDom(page, tn) {
        const bodyText = await page.innerText('body');
        if (!bodyText) return null;

        const lower = bodyText.toLowerCase();
        if (lower.includes("can't find that tracking number") || lower.includes("cannot find that tracking number") || lower.includes("no record of this tracking")) {
            return createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.FEDEX,
                status: TrackingStatusEnum.INVALID,
                statusDescription: "We can't find that tracking number.",
                delivered: false
            });
        }

        let statusText = '';
        const headingEl = await page.$(FEDEX_SELECTORS.HEADING_BLOCK);
        if (headingEl) {
            statusText = (await headingEl.innerText() || '').trim();
        }

        const statusEl = await page.$(FEDEX_SELECTORS.SHIPMENT_STATUS);
        if (statusEl && !statusText) {
            statusText = (await statusEl.innerText() || '').trim();
        }

        if (statusText) {
            const norm = this.normalizeStatus(statusText);
            if (norm !== TrackingStatusEnum.UNKNOWN) {
                let details = null;
                let expDate = null;
                if (statusText.toUpperCase().includes('SIGNED FOR BY:')) {
                    const match = statusText.match(/SIGNED FOR BY:[^\n]+/i);
                    if (match) details = match[0].trim();
                }

                const lines = statusText.split('\n').map(l => l.trim()).filter(Boolean);
                const dateCandidates = lines.filter(l => /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}\/\d{1,2}|at|\d{1,2}:\d{2})\b/i.test(l));
                if (dateCandidates.length) {
                    expDate = dateCandidates.slice(0, 2).join(' ');
                }

                const isDeliv = norm === TrackingStatusEnum.DELIVERED;
                return createTrackingResult({
                    trackingNumber: tn,
                    carrier: CarrierEnum.FEDEX,
                    status: norm,
                    statusDescription: isDeliv ? 'Delivered' : lines[0],
                    details,
                    expectedDelivery: expDate,
                    delivered: isDeliv
                });
            }
        }

        return null;
    }
}

export default FedExService;
