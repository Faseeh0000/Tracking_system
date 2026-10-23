import axios from "axios";
import { SendEmail } from "../config/email.js";
import { Outbox } from "../models/outbox.js";
import { getCompanyDetailsbyName } from "../config/env.js";

const Retry = [5 * 1000, 10 * 1000, 15 * 60 * 1000];
const Max_Attempts = 4;

const getAgenda = async () => {
  const { default: agenda } = await import("../config/agenda.js");
  return agenda;
};

export const queueWebhook = async (event, payload, company) => {

  const outboxEvent = await Outbox.create({
    company,
    event,
    payload,
    deliveryStatus: "PENDING",
    attempts: 0,
    lastAttempt: null,
    nextRetryAt: null,
    lastResponse: {
      statusCode: null,
      body: null,
    },
  });

  const agenda = await getAgenda();
  await agenda.now("send-webhook", { eventId: outboxEvent._id });
  return outboxEvent;
};

export const processOutboxEvent = async (eventId) => {
  const event = await Outbox.findById(eventId);
  if (!event) {
    console.log(`Outbox event not found: ${eventId}`);
    return;
  }

  try {
    const company = getCompanyDetailsbyName(event.company);
    if (!company) {
      throw new Error(`Unknown company in outbox event: ${event.company}`);
    }

    const WEBHOOK_URL = company.webhookPath;

    if (!WEBHOOK_URL) {
      console.error("WEBHOOK_URL is not configured in .env");
      return;
    }

    const response = await axios.post(
      WEBHOOK_URL,
      {
        eventId: event._id,
        event: event.event,
        company: event.company,
        data: event.payload,
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 },
    );

    event.deliveryStatus = "SUCCESS";
    event.lastAttempt = new Date();
    event.lastResponse = {
      statusCode: response.status,
      body: response.data,
    };
    await event.save();
    console.log(
      `Webhook delivered for ${event.payload?.trackingNumber || event._id}`,
    );
    return response.data;
  } catch (error) {
    event.attempts += 1;
    event.lastAttempt = new Date();
    event.lastResponse = {
      statusCode: error.response?.status || null,
      body: error.response?.data || {
        message: error.message,
      },
    };

    if (event.attempts >= Max_Attempts) {
      event.deliveryStatus = "DEAD";
      event.nextRetryAt = null;
      await event.save();
      await SendEmail(event, error.message);
      console.error(
        `Webhook permanently failed after ${event.attempts} attempts`,
      );
      return;
    }

    const retryDelay = Retry[event.attempts - 1];
    event.deliveryStatus = "RETRYING";
    event.nextRetryAt = new Date(Date.now() + retryDelay);
    await event.save();

    const agenda = await getAgenda();
    await agenda.schedule(event.nextRetryAt, "send-webhook", {
      eventId: event._id,
    });

    console.error(
      `Webhook attempt ${event.attempts} failed. Retrying in ${retryDelay}ms`,
    );
  }
};
