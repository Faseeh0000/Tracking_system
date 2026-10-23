import "./env.js";
import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";
import { processOutboxEvent } from "../services/webhookService.js";
import { GetData } from "../services/emailFatcher.js";
import {
  trackActiveShipments,
  sendDailyTrackingFailureAlert,
} from "../services/trackingService.js";
import { companies } from "./env.js";

const agenda = new Agenda({
  backend: new MongoBackend({ address: process.env.URI }),
});

// Shared job queue — ensures only one scheduled job runs at a time
let jobQueue = Promise.resolve();

function enqueue(name, fn) {
  jobQueue = jobQueue.then(async () => {
    try {
      console.log(`\n[Agenda] ▶ Starting: ${name}`);
      await fn();
      console.log(`[Agenda] ✔ Completed: ${name}\n`);
    } catch (error) {
      console.error(`[Agenda] ✖ Failed: ${name} —`, error.message);
    }
  });
  return jobQueue;
}

agenda.define("send-webhook", async (job) => {
  const { eventId } = job.attrs.data;
  await processOutboxEvent(eventId);
});

agenda.define("alert-failed-tracking-events", async () => {
  await enqueue("alert-failed-tracking-events", async () => {
    await sendDailyTrackingFailureAlert();
  });
});

agenda.define(
  "fetch-tracking-emails",
  async () => {
    await enqueue("fetch-tracking-emails", async () => {
      for (const company of companies) {
        console.log(`[Email] starting company: ${company.name}`);
        try {
          await GetData(company);
          console.log(`[Email] finished company: ${company.name}`);
        } catch (error) {
          console.error(
            `[Email] Company ${company.name} failed; continuin to next company:`,
            error.message,
          );
        }
      }
    });
  },
  { lockLifetime: 10 * 60 * 1000 },
);

agenda.define(
  "track-active-shipments",
  async () => {
    await enqueue("track-active-shipments", async () => {
      await trackActiveShipments();
    });
  },
  { lockLifetime: 10 * 60 * 1000 },
);

export const startAgenda = async () => {
  await agenda.start();
  console.log("[Agenda] Agenda scheduler started successfully");
  if (
    process.env.TESTING === "true" ||
    process.env.RUN_TRACKER_ON_STARTUP === "true"
  ) {
    console.log(
      "[Agenda] Testing mode detected: triggering immediate 'track-active-shipments' run...",
    );
    await agenda.now("track-active-shipments");
  }
  const fetchEmailsInterval = process.env.FETCH_EMAILS_INTERVAL || "1 hour";
  const trackShipmentsInterval =
    process.env.TRACK_SHIPMENTS_INTERVAL || "6 hours";

  console.log(`[Agenda] Job intervals configured:`);
  console.log(`  • fetch-tracking-emails : "${fetchEmailsInterval}"`);
  console.log(`  • track-active-shipments: "${trackShipmentsInterval}"`);

  await agenda.now("fetch-tracking-emails");
  await agenda.now("track-active-shipments");
  await agenda.every(fetchEmailsInterval, "fetch-tracking-emails");
  await agenda.every(trackShipmentsInterval, "track-active-shipments");
  await agenda.every("0 10 * * *", "alert-failed-tracking-events", undefined, {
    timezone: "Asia/Karachi",
  });
  return agenda;
};

export default agenda;
