import "./env.js";
import nodemailer from "nodemailer";

export const SendEmail = async (payload, error) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.USER,
      pass: process.env.PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.USER,
    to: process.env.EMAIL || process.env.USER,
    subject: "Webhook Delivery Failed",
    text: `Webhook failed.\nError: ${error}\nPayload: ${JSON.stringify(payload)}`,
  });

  console.log("Delivery notified via email");
};

export const SendTrackingFailureAlert = async (events) => {
  if (!events.length) return;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.USER,
      pass: process.env.PASS,
    },
  });

  const details = events
    .map((event, index) => {
      const trackingNumbers = event.trackingNumber.join(", ");
      return [
        `${index + 1}. Courier: ${event.courier || "Unknown"}`,
        `   Tracking numbers: ${trackingNumbers}`,
        `   Error: ${event.message || "No error details"}`,
        `   First recorded: ${event.createdAt.toISOString()}`,
      ].join("\n");
    })
    .join("\n\n");

  await transporter.sendMail({
    from: process.env.USER,
    to: process.env.EMAIL || process.env.USER,
    subject: `Unresolved tracking failures: ${events.length}`,
    text: `These tracking batches have not yet recovered:\n\n${details}`,
  });
};
