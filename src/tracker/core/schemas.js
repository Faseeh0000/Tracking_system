/**
 * Carrier and status enumerations + result factory.
 * Portable — zero external dependencies.
 */

export const CarrierEnum = Object.freeze({
    FEDEX: 'FEDEX',
    UPS: 'UPS',
    USPS: 'USPS',
    UNKNOWN: 'UNKNOWN'
});

export const TrackingStatusEnum = Object.freeze({
    DELIVERED: 'DELIVERED',
    OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
    IN_TRANSIT: 'IN_TRANSIT',
    ACCEPTED: 'ACCEPTED',
    INVALID: 'INVALID',
    EXCEPTION: 'EXCEPTION',
    UNKNOWN: 'UNKNOWN',
    ERROR: 'ERROR'
});

export function createTrackingResult({
    trackingNumber,
    carrier = CarrierEnum.UNKNOWN,
    status = TrackingStatusEnum.UNKNOWN,
    statusDescription = '',
    details = null,
    expectedDelivery = null,
    delivered = false,
    raw = null
}) {
    return {
        trackingNumber: String(trackingNumber || ''),
        carrier: String(carrier || CarrierEnum.UNKNOWN),
        status: String(status || TrackingStatusEnum.UNKNOWN),
        statusDescription: String(statusDescription || ''),
        details: details ? String(details) : null,
        expectedDelivery: expectedDelivery ? String(expectedDelivery) : null,
        delivered: Boolean(delivered),
        raw: raw || null
    };
}
