import { CarrierEnum, TrackingStatusEnum, createTrackingResult } from './core/schemas.js';
import FedExService from './services/fedex.service.js';
import UPSService from './services/ups.service.js';
import USPSService from './services/usps.service.js';

export function cleanTrackingNumber(trackingNumber) {
    if (!trackingNumber || typeof trackingNumber !== 'string') return '';
    return trackingNumber.replace(/[\s-]+/g, '').trim();
}

export function detectCarrier(trackingNumber) {
    const clean = cleanTrackingNumber(trackingNumber).toUpperCase();
    if (!clean) {
        throw new Error('Tracking number cannot be empty');
    }

    // 1. UPS Check
    if (/^1Z[A-Z0-9]{16}$/.test(clean) || /^T\d{10}$/.test(clean)) {
        return CarrierEnum.UPS;
    }

    // 2. USPS Check
    if (/^(9[1-5]\d{19,23}|9\d{21})$/.test(clean) ||
        /^420\d{5}9\d{21,23}$/.test(clean) ||
        /^[A-Z]{2}\d{9}US$/.test(clean)) {
        return CarrierEnum.USPS;
    }

    // 3. FedEx Check
    if (/^\d{12}$/.test(clean) ||
        /^\d{15}$/.test(clean) ||
        (/^\d{20}$/.test(clean) && !clean.startsWith('9')) ||
        /^\d{34}$/.test(clean)) {
        return CarrierEnum.FEDEX;
    }

    // 4. Fallback service validations
    if (UPSService.isValid(clean)) return CarrierEnum.UPS;
    if (USPSService.isValid(clean)) return CarrierEnum.USPS;
    if (FedExService.isValid(clean)) return CarrierEnum.FEDEX;

    throw new Error(`Unable to determine carrier for tracking number: '${trackingNumber}'. Please specify carrier explicitly.`);
}

export class TrackerService {
    static PROVIDERS = {
        [CarrierEnum.FEDEX]: FedExService,
        [CarrierEnum.UPS]: UPSService,
        [CarrierEnum.USPS]: USPSService
    };

    static listProviders() {
        return Object.keys(this.PROVIDERS);
    }

    static getProvider(carrierOrTn) {
        if (!carrierOrTn) throw new Error('Carrier or tracking number required');
        const normalized = String(carrierOrTn).trim().toUpperCase();
        if (this.PROVIDERS[normalized]) {
            return this.PROVIDERS[normalized];
        }
        const detected = detectCarrier(normalized);
        if (this.PROVIDERS[detected]) {
            return this.PROVIDERS[detected];
        }
        throw new Error(`Unsupported provider: '${carrierOrTn}'`);
    }

    static async track(trackingNumber, carrier = null, options = {}) {
        if (typeof trackingNumber === 'string' && trackingNumber.includes(',')) {
            const batchRes = await this.trackBatch([trackingNumber], carrier, options);
            return batchRes[0] || null;
        }

        const cleanTn = cleanTrackingNumber(trackingNumber);
        const selectedCarrier = carrier ? String(carrier).trim().toUpperCase() : detectCarrier(cleanTn);
        const provider = this.getProvider(selectedCarrier);
        return await provider.track(cleanTn, options);
    }

    static async trackBatch(trackingNumbers, carrier = null, options = {}) {
        let flatNumbers = [];
        const rawList = Array.isArray(trackingNumbers) ? trackingNumbers : [trackingNumbers];

        for (const item of rawList) {
            if (typeof item === 'string' && item.includes(',')) {
                flatNumbers.push(...item.split(',').map(x => x.trim()).filter(Boolean));
            } else if (item) {
                flatNumbers.push(String(item).trim());
            }
        }

        if (!flatNumbers.length) return [];

        if (carrier) {
            const provider = this.getProvider(carrier);
            return await provider.trackBatch(flatNumbers, options);
        }

        // Group by auto-detected carrier, preserve original index
        const indexedItems = [];
        for (let idx = 0; idx < flatNumbers.length; idx++) {
            const rawTn = flatNumbers[idx];
            const cleanTn = cleanTrackingNumber(rawTn);
            try {
                const c = detectCarrier(cleanTn);
                indexedItems.push({ index: idx, tn: cleanTn, carrier: c, error: null });
            } catch (err) {
                indexedItems.push({ index: idx, tn: cleanTn, carrier: null, error: err.message });
            }
        }

        const groups = {};
        const unresolvable = [];

        for (const item of indexedItems) {
            if (!item.carrier) {
                unresolvable.push({
                    _index: item.index,
                    result: createTrackingResult({
                        trackingNumber: item.tn,
                        carrier: CarrierEnum.UNKNOWN,
                        status: TrackingStatusEnum.ERROR,
                        statusDescription: item.error || 'Unknown carrier',
                        delivered: false
                    })
                });
            } else {
                if (!groups[item.carrier]) groups[item.carrier] = [];
                groups[item.carrier].push(item);
            }
        }

        const taskPromises = Object.entries(groups).map(async ([groupCarrier, items]) => {
            const provider = this.PROVIDERS[groupCarrier];
            const tns = items.map(i => i.tn);
            const results = await provider.trackBatch(tns, options);
            return results.map((res, i) => ({
                _index: items[i].index,
                result: res
            }));
        });

        const groupResults = await Promise.all(taskPromises);
        const combined = [...unresolvable];
        for (const resList of groupResults) {
            combined.push(...resList);
        }

        combined.sort((a, b) => a._index - b._index);
        return combined.map(c => c.result);
    }
}

export default TrackerService;
