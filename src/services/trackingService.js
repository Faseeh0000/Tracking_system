import { Shipment } from "../models/shipment.js";
import { queueWebhook } from "./webhookService.js";
import * as tracker from "../tracker/index.js";
import { FailTrackingEvent } from "../models/FailTrackingEvent.js";
import { SendTrackingFailureAlert } from "../config/email.js";

export const sendDailyTrackingFailureAlert = async () => {
  const unresolvedEvents = await FailTrackingEvent.find({
    successful: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .lean();

  if (!unresolvedEvents.length) {
    console.log("No unresolved tracking failures to report");
    return;
  }

  await SendTrackingFailureAlert(unresolvedEvents);
  console.log(
    `Sent daily alert for ${unresolvedEvents.length} unresolved tracking failure(s)`,
  );
};

const logTrackingEvent = async (trackingNumbers, courier, message) => {
  await FailTrackingEvent.create({
    trackingNumber: trackingNumbers,
    courier: courier,
    message,
    successful: false,
    successfulTrackingNumbers: [],
  });
};

const Final_Status = ["delivered", "cancelled", "returned", "lost"];

function normalizeStatus(status) {
  return status?.trim().toLowerCase();
}

export const createShipment = async (
  poNumber,
  trackingNumber,
  lineItems = [],
  company,
) => {
  const existing = await Shipment.findOne({ trackingNumber, poNumber });

  if (existing) {
    if (existing.tracking.enabled) {
      console.log(`${trackingNumber}: shipment already exists`);
      return existing;
    }

    return null;
  }

  let courier;

  try {
    courier = tracker.detectCarrier(trackingNumber);
  } catch (error) {
    console.log(
      `${trackingNumber}: This tracking number is invalid or carrier could not be detected`,
    );
    return null;
  }

  const shipment = await Shipment.create({
    company,
    poNumber,
    trackingNumber,
    courier,
    status: "pending",

    tracking: {
      enabled: true,
      lastCheckedAt: null,
    },
    statusHistory: [],
    lineItems,
  });

  console.log(`New shipment created: ${shipment}  `);

  return shipment;
};

export const trackActiveShipments = async () => {
  const Batch_size = 25;

  const couriers = await Shipment.distinct("courier", {
    "tracking.enabled": true,
    courier: { $nin: [null, ""] },
  });

  if (!couriers.length) {
    console.log("No parcels remaining to track");
    return;
  }

  for (const courier of couriers) {
    let skip = 0;

    console.log(`Starting tracking for courier: ${courier} `);

    while (true) {
      const batch = await Shipment.find({
        "tracking.enabled": true,
        courier,
      })
        .skip(skip)
        .limit(Batch_size);

      if (batch.length === 0) {
        break;
      }

      console.log(
        `${courier}: tracking batch of ${batch.length} (offset ${skip})`,
      );

      skip += Batch_size;

      await processShipment(batch, courier);
    }
  }
};

const markRecoveredTrackingEvents = async (trackingNumbers, courier) => {
  const successfulNumbers = new Set(trackingNumbers);

  const unresolvedEvents = await FailTrackingEvent.find({
    courier,
    successful: { $ne: true },
    trackingNumber: { $in: trackingNumbers },
  });

  for (const event of unresolvedEvents) {
    const recoveredNumbers = new Set([
      ...(event.successfulTrackingNumbers || []),
      ...event.trackingNumber.filter((number) => successfulNumbers.has(number)),
    ]);

    event.successfulTrackingNumbers = [...recoveredNumbers];
    event.successful = event.trackingNumber.every((number) =>
      recoveredNumbers.has(number),
    );

    await event.save();
  }
};

const processShipment = async (shipments, courier) => {
  const trackingNumbers = shipments.map((shipment) => shipment.trackingNumber);

  let results;

  try {
    results = await tracker.trackBatch(trackingNumbers, courier);
  } catch (error) {
    console.error(`Failed to track ${courier} batch:`, error.message);

    await logTrackingEvent(
      trackingNumbers,
      courier,
      `Carrier tracking request failed: ${error.message}`,
    );

    return;
  }

  const batchFailed =
    !Array.isArray(results) ||
    results.length !== shipments.length ||
    results.some((result) => {
      const status = normalizeStatus(result?.status);
      return !status || status === "unknown" || status === "error";
    });

  if (batchFailed) {
    console.error(
      `${courier}: batch failed or returned an unknown/error result; skipping all shipment updates`,
    );

    await logTrackingEvent(
      trackingNumbers,
      courier,
      "Batch failed or returned an unknown/error result",
    );

    return;
  }

  const successfullyTrackedNumbers = [];

  for (let i = 0; i < shipments.length; i++) {
    try {
      await processTracking(shipments[i], results[i]);

      successfullyTrackedNumbers.push(shipments[i].trackingNumber);
    } catch (error) {
      console.error(
        `Failed to process ${shipments[i].trackingNumber}:`,
        error.message,
      );
    }
  }
  if (successfullyTrackedNumbers.length > 0) {
    await markRecoveredTrackingEvents(successfullyTrackedNumbers, courier);
  }
};

const processTracking = async (ship, result) => {
  if (!result) {
    console.error(`No tracking result for ${ship.trackingNumber}`);
    return;
  }

  const carrierName = result.carrier || result.courier;
  if (carrierName && !ship.courier) {
    ship.courier = carrierName;
  }

  const oldStatus = normalizeStatus(ship.status);
  const newStatus = normalizeStatus(result.status);

  ship.tracking.lastCheckedAt = new Date();

  // Status did not change
  if (oldStatus === newStatus) {
    await ship.save();

    console.log(`${ship.trackingNumber}: status unchanged(${newStatus})`);

    return;
  }

  // Update status
  ship.status = newStatus;

  ship.statusHistory.push({
    status: newStatus,
    timestamp: new Date(),
  });

  // Stop tracking final statuses
  if (Final_Status.includes(newStatus)) {
    ship.tracking.enabled = false;
  }

  await ship.save();

  console.log(`${ship.trackingNumber}: ${oldStatus} -> ${newStatus} `);

  // Send webhook only when status changes
  await queueWebhook(
    "shipment.status.updated",
    {
      referenceNumber: ship.poNumber,
      trackingNumber: ship.trackingNumber,
      status: newStatus,
      courier: ship.courier || carrierName || null,
      lineItems: ship.lineItems,
    },
    ship.company,
  );
};

export const GetShipment = async (req, res) => {
  const { TrackingNo, courier } = req.body;

  if (!TrackingNo || !courier) {
    return res.status(400).json({
      error: "Tracking number and courier required",
    });
  }

  try {
    const results = await tracker.trackBatch(TrackingNo, courier);

    if (!results || results.length === 0) {
      return res.status(500).json({
        error: "Tracking failed",
      });
    }

    return res.status(200).json(results);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};

export const GetShipments = async (req, res) => {
  const { TrackingNos, courier } = req.body;

  if (
    !TrackingNos ||
    !Array.isArray(TrackingNos) ||
    TrackingNos.length === 0 ||
    !courier
  ) {
    return res.status(400).json({
      error: "Tracking numbers (array) and courier required",
    });
  }

  try {
    console.log("Start Tracking");

    const results = await tracker.trackBatch(TrackingNos, courier);

    if (!results || results.length === 0) {
      return res.status(500).json({
        error: "Tracking failed or no results",
      });
    }

    return res.status(200).json(results);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
};
