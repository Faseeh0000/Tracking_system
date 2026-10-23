import "./env.js";
import { Client } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential } from "@azure/identity";

const clientsByCompany = new Map();

export function getGraphClient(company) {
  if (!company?.name || !company.graph) {
    throw new Error("Company name and Graph credentials are required");
  }

  const { tenantId, clientId, clientSecret } = company.graph;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(`Graph credentials are incomplete for ${company.name}`);
  }

  const cachedClient = clientsByCompany.get(company.name);
  if (cachedClient) {
    return cachedClient;
  }

  const credential = new ClientSecretCredential(
    tenantId,
    clientId,
    clientSecret,
  );

  const graphClient = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken(
          "https://graph.microsoft.com/.default",
        );

        if (!token?.token) {
          throw new Error(`Could not obtain a Graph token for ${company.name}`);
        }

        return token.token;
      },
    },
  });

  clientsByCompany.set(company.name, graphClient);
  return graphClient;
}
