import mongoose from "mongoose";

const shipmentSchema = mongoose.Schema(
  {
    company: {
      type: String,
      required: true,
    },
    poNumber: {
      type: String,
      required: true,
    },

    trackingNumber: {
      type: String,
      required: true,
    },

    courier: String,

    status: {
      type: String,
      default: "pending",
    },

    tracking: {
      enabled: {
        type: Boolean,
        default: true,
      },
      lastCheckedAt: Date,
    },

    statusHistory: [
      {
        status: {
          type: String,
          required: true,
          trim: true,
        },

        timestamp: Date,
      },
    ],
    lineItems: [
      {
        lineNo: {
          type: Number,
          default: null,
        },

        itemCode: {
          type: String,
          default: "",
          trim: true,
        },

        description: {
          type: String,
          default: "",
          trim: true,
        },

        qtyOrdered: {
          type: Number,
          default: 0,
        },

        qtyShipped: {
          type: Number,
          default: 0,
        },

        BO: {
          type: Number,
          default: 0,
        },
      },
    ],
  },
  { timestamps: true },
);

shipmentSchema.index({ poNumber: 1, trackingNumber: 1 }, { unique: true });

export const Shipment = mongoose.model("Shipment", shipmentSchema);
