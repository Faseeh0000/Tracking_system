import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const rootEnvPath = path.resolve(__dirname, "../../.env");

dotenv.config({ path: rootEnvPath, override: true });

export const companies = [
  {
    email: process.env.COMPRESSIONCARE_EMAIL,
    webhookPath: process.env.COMPRESSIONCARE_WEBHOOK_PATH,
    name: "compressioncare",
    graph: {
      tenantId: process.env.MICROSOFT_TENANT_ID,
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    },
  },
  {
    email: process.env.PRETYPINK_EMAIL,
    webhookPath: process.env.PRETYPINK_WEBHOOK_PATH,
    name: "prettypink",
    graph: {
      tenantId: process.env.PRETYPINK_TENANT_ID,
      clientId: process.env.PRETYPINK_CLIENT_ID,
      clientSecret: process.env.PRETYPINK_CLIENT_SECRET,
    },
  },
  {
    email: process.env.JUSTLIKEAWOMAN_EMAIL,
    webhookPath: process.env.JUSTLIKEAWOMAN_WEBHOOK_PATH,
    name: "justlikawoman",
    graph: {
      tenantId: process.env.MICROSOFT_TENANT_ID,
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    },
  },
];

export function getCompanyDetailsbyName(name) {
  return companies.find((company) => company.name === name);
}

export default dotenv;
