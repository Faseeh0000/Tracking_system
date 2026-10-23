import mongoose from "mongoose";

const outboxSchema = mongoose.Schema(
  {
    event: String,
    company: {
      type: String,
      required: true,
    },
    payload: {
      type: mongoose.SchemaTypes.Mixed,
    },

    deliveryStatus: {
      type: String,
      enum: ["PENDING", "SUCCESS", "RETRYING", "DEAD"],
      default: "PENDING",
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastAttempt: {
      type: Date,
      default: null,
    },
    nextRetryAt: {
      type: Date,
      default: null,
    },
    lastResponse: {
      statusCode: Number,
      body: mongoose.SchemaTypes.Mixed,
    },
  },
  { timestamps: true },
);

export const Outbox = mongoose.model("Outbox", outboxSchema);
