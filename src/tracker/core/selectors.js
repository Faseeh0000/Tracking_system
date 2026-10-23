/**
 * Unified DOM / CSS selectors for carrier tracking pages.
 * Centralised so a single update propagates everywhere.
 */

export const USPS_SELECTORS = Object.freeze({
    CARD_CONTAINERS: '.track-bar-container, .product_summary',
    TRACKING_NUMBER: '.tracking-number',
    STATUS: '.tb-step.current-step .tb-status, .tb-status, .delivery_status, .status',
    STATUS_DETAIL: '.tb-step.current-step .tb-status-detail, .tb-status-detail',
    BANNER_HEADER: '.banner-header',
    BANNER_CONTENT: '.banner-content, .statusSummaryText',
    LOCATION: '.tb-step.current-step .tb-location, .tb-location',
    DATE: '.tb-step.current-step .tb-date, .tb-date, .expected_delivery, .delivery_date, .package-delivery-date',
    BANNER_CHECK: '.banner-header, .banner-content'
});

export const FEDEX_SELECTORS = Object.freeze({
    HEADING_BLOCK: '.phase3-view__heading-block, [class*="phase3-view__heading-block"]',
    SHIPMENT_STATUS: '.shipment-status, .shipment-status--wrap, [class*="shipment-status"]'
});

export const UPS_SELECTORS = Object.freeze({
    PACKAGE_STATUS: '#stApp_lblPackageStatus, [class*="package_status"], [class*="milestone_status"]'
});
