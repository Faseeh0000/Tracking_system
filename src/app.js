import "./config/env.js";
import express from "express";
import connectDB from "./config/db.js";
import { startAgenda } from "./config/agenda.js";
import router from "./routes/indexRoute.js";
import { initialize as initTracker, shutdown as shutdownTracker } from "./tracker/index.js";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/app", router);

const PORT = process.env.PORT || 3002;

const start = async () => {
  await connectDB();

  const headlessEnv = process.env.HEADLESS ? String(process.env.HEADLESS).trim().toLowerCase() : '';
  const headless = headlessEnv === 'virtual' ? 'virtual' : (headlessEnv === 'true' || headlessEnv === '1');

  // Initialize tracking module via its abstract interface with environment configuration
  await initTracker({
    headless,
    proxy: process.env.PROXY || undefined,
    uspsProxy: process.env.USPS_PROXY || undefined,
    httpProxy: process.env.HTTP_PROXY || undefined,
    maxTrackingRetries: process.env.MAX_TRACKING_RETRIES ? Number(process.env.MAX_TRACKING_RETRIES) : undefined,
  });

  await startAgenda();

  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });

  const handleShutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Gracefully shutting down...`);
    try {
      await shutdownTracker();
    } catch (err) {
      console.error("Error shutting down tracker:", err.message);
    }
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
};

start().catch((error) => {
  console.error("Failed to start application:", error.message);
  process.exit(1);
});
