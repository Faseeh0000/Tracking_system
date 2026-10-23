import mongoose from "mongoose";

const trackingEventSchema = mongoose.Schema(
  {
    trackingNumber: [{ type: String }],
    courier: { type: String },
    message: { type: String },
    createdAt: { type: Date, default: Date.now },
    successful: {
      type: Boolean,
      default: false,
    },
    successfulTrackingNumbers: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

trackingEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

export const FailTrackingEvent = mongoose.model(
  "TrackingEvent",
  trackingEventSchema,
);
