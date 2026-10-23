import BrowserManager from '../core/browser.manager.js';
import { CarrierEnum, TrackingStatusEnum, createTrackingResult } from '../core/schemas.js';
import { UPS_SELECTORS } from '../core/selectors.js';
import { getLogger } from '../core/logger.js';

const log = getLogger().tag('UPS');

export class UPSService {
    static isValid(tn) {
        if (!tn || typeof tn !== 'string') return false;
        const clean = tn.replace(/\s+/g, '').toUpperCase();
        const isStandard1Z = /^1Z[A-Z0-9]{16}$/.test(clean);
        const isNumeric = /^\d{9,12}$/.test(clean) || /^\d{22}$/.test(clean) || /^T\d{10}$/.test(clean);
        return isStandard1Z || isNumeric;
    }

    static normalizeStatus(text) {
        if (!text) return TrackingStatusEnum.UNKNOWN;
        const s = String(text).toUpperCase();
        if (s.includes('DELIVERED')) return TrackingStatusEnum.DELIVERED;
        if (s.includes('OUT FOR DELIVERY')) return TrackingStatusEnum.OUT_FOR_DELIVERY;
        if (['ON THE WAY', 'IN TRANSIT', 'DEPARTED', 'ARRIVED'].some(k => s.includes(k))) return TrackingStatusEnum.IN_TRANSIT;
        if (['LABEL CREATED', 'ORDER PROCESSED', 'SHIPPER CREATED'].some(k => s.includes(k))) return TrackingStatusEnum.ACCEPTED;
        if (['INVALID', 'NOT FOUND'].some(k => s.includes(k))) return TrackingStatusEnum.INVALID;
        if (['DELAY', 'EXCEPTION', 'ERROR', 'UNABLE'].some(k => s.includes(k))) return TrackingStatusEnum.EXCEPTION;
        return s;
    }

    static async track(trackingNumber, options = {}) {
        const results = await this.trackBatch([trackingNumber], options);
        return results[0] || createTrackingResult({
            trackingNumber,
            carrier: CarrierEnum.UPS,
            status: TrackingStatusEnum.ERROR,
            statusDescription: 'No result returned',
            delivered: false
        });
    }

    static async trackBatch(trackingNumbers, options = {}) {
        const cleanTns = trackingNumbers
            .map(tn => tn ? String(tn).replace(/[\s-]+/g, '') : '')
            .filter(Boolean);

        if (!cleanTns.length) return [];

        return await BrowserManager.withTab('UPS', async (page) => {
            const results = [];

            for (let idx = 0; idx < cleanTns.length; idx++) {
                const tn = cleanTns[idx];
                const interceptedApi = {};

                const handleResponse = async (response) => {
                    try {
                        if (response.url().includes('/api/Track/GetStatus') && response.status() === 200) {
                            const json = await response.json();
                            if (json && typeof json === 'object') {
                                interceptedApi.data = json;
                            }
                        }
                    } catch (_) {}
                };

                page.on('response', handleResponse);

                if (idx > 0) {
                    try {
                        await page.goto('about:blank');
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (_) {}
                }

                log.info(`[${idx + 1}/${cleanTns.length}] Tracking: ${tn}`);
                const targetUrl = `https://www.ups.com/track?loc=en_US&tracknum=${tn}&requester=ST/`;

                try {
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                } catch (err) {
                    log.warn(`Navigation warning for ${tn}: ${err.message}`);
                }

                const startWait = Date.now();
                let itemResult = null;

                while ((Date.now() - startWait) < 15000) {
                    if (page.isClosed()) break;

                    if (interceptedApi.data) {
                        itemResult = this._parseApiResponse(tn, interceptedApi.data);
                        if (itemResult && itemResult.status !== TrackingStatusEnum.UNKNOWN) {
                            break;
                        }
                    }

                    try {
                        const domRes = await this._checkDom(page, tn);
                        if (domRes && domRes.status !== TrackingStatusEnum.UNKNOWN) {
                            itemResult = domRes;
                            break;
                        }
                    } catch (_) {}

                    await new Promise(r => setTimeout(r, 500));
                }

                if (!itemResult && interceptedApi.data) {
                    itemResult = this._parseApiResponse(tn, interceptedApi.data);
                }

                if (!itemResult) {
                    itemResult = createTrackingResult({
                        trackingNumber: tn,
                        carrier: CarrierEnum.UPS,
                        status: TrackingStatusEnum.UNKNOWN,
                        statusDescription: 'No tracking information could be extracted from UPS',
                        delivered: false
                    });
                }

                page.off('response', handleResponse);
                if (itemResult.status === TrackingStatusEnum.DELIVERED) {
                    log.success(`${tn} -> ${itemResult.status} (${itemResult.statusDescription})`);
                } else if (itemResult.status === TrackingStatusEnum.UNKNOWN || itemResult.status === TrackingStatusEnum.ERROR) {
                    log.warn(`${tn} -> ${itemResult.status} (${itemResult.statusDescription})`);
                } else {
                    log.info(`${tn} -> ${itemResult.status} (${itemResult.statusDescription})`);
                }
                results.push(itemResult);
            }

            return results;
        });
    }

    static _parseApiResponse(tn, apiData) {
        try {
            const trackDetailsList = apiData?.trackDetails || [];
            if (!trackDetailsList.length) {
                return createTrackingResult({
                    trackingNumber: tn,
                    carrier: CarrierEnum.UPS,
                    status: TrackingStatusEnum.UNKNOWN,
                    statusDescription: 'No tracking details in UPS response',
                    delivered: false
                });
            }

            const trackDetails = trackDetailsList[0];
            if (trackDetails?.errorCode || trackDetails?.errorText) {
                return createTrackingResult({
                    trackingNumber: tn,
                    carrier: CarrierEnum.UPS,
                    status: TrackingStatusEnum.INVALID,
                    statusDescription: trackDetails.errorText || 'Tracking number not found in database',
                    delivered: false
                });
            }

            let statusDesc = trackDetails?.packageStatus;
            if (!statusDesc && trackDetails?.milestoneList?.length) {
                statusDesc = trackDetails.milestoneList[0]?.milestoneTitle;
            }
            if (!statusDesc) statusDesc = 'Status Available';

            const isDelivered = Boolean(trackDetails?.isDelivered || statusDesc.toLowerCase().includes('delivered'));

            const delivDate = (
                trackDetails?.deliveredDateDetail?.date ||
                trackDetails?.scheduledDeliveryDateDetail?.date ||
                trackDetails?.scheduledDeliveryDate ||
                null
            );

            const activities = trackDetails?.shipmentProgressActivities || [];
            let location = null;
            if (activities.length > 0) {
                const locObj = activities[0]?.location || {};
                const parts = [locObj.city, locObj.stateProvince].filter(Boolean);
                if (parts.length) location = parts.join(', ');
            }

            const details = trackDetails?.additionalInformation || location || null;

            return createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.UPS,
                status: this.normalizeStatus(statusDesc),
                statusDescription: statusDesc,
                details,
                expectedDelivery: delivDate,
                delivered: isDelivered
            });
        } catch (e) {
            return createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.UPS,
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
        if (lower.includes('invalid') && (lower.includes('tracking error') || lower.includes('please provide a tracking number'))) {
            return createTrackingResult({
                trackingNumber: tn,
                carrier: CarrierEnum.UPS,
                status: TrackingStatusEnum.INVALID,
                statusDescription: 'Invalid tracking number or not found by UPS',
                delivered: false
            });
        }

        const el = await page.$(UPS_SELECTORS.PACKAGE_STATUS);
        if (el) {
            const txt = (await el.innerText() || '').trim();
            if (txt) {
                return createTrackingResult({
                    trackingNumber: tn,
                    carrier: CarrierEnum.UPS,
                    status: this.normalizeStatus(txt),
                    statusDescription: txt,
                    delivered: txt.toLowerCase().includes('delivered')
                });
            }
        }

        return null;
    }
}

export default UPSService;
