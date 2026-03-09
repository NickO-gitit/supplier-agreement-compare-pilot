import { AppConfigurationClient } from "@azure/app-configuration";
import { ManagedIdentityCredential } from "@azure/identity";

const TENANT_CONFIG_KEYS = [
  "FOUNDRY_PROJECT_ENDPOINT",
  "AZURE_FOUNDRY_ENDPOINT",
  "FOUNDRY_DEPLOYMENT",
  "FOUNDRY_API_VERSION",
  "OPENAI_MODEL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
];

export async function loadTenantConfig(logger = console) {
  const endpoint = normalize(process.env.APP_CONFIG_ENDPOINT);
  if (!endpoint) {
    logger.info?.("APP_CONFIG_ENDPOINT not set; skipping Azure App Configuration load.");
    return;
  }

  try {
    const clientId = normalize(process.env.AZURE_CLIENT_ID);
    const credential = clientId
      ? new ManagedIdentityCredential(clientId)
      : new ManagedIdentityCredential();
    const client = new AppConfigurationClient(endpoint, credential);
    const label = normalize(process.env.APP_CONFIG_LABEL);

    let loaded = 0;
    for (const key of TENANT_CONFIG_KEYS) {
      const value = await getSettingValue(client, key, label);
      if (typeof value === "string" && value.trim().length > 0) {
        process.env[key] = value;
        loaded += 1;
      }
    }

    logger.info?.(`Loaded ${loaded} runtime setting(s) from Azure App Configuration.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`App Configuration load failed, continuing with existing env vars: ${message}`);
  }
}

async function getSettingValue(client, key, label) {
  try {
    const byLabel = await client.getConfigurationSetting({
      key,
      label: label || null,
    });
    if (typeof byLabel.value === "string") {
      return byLabel.value;
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  try {
    const fallback = await client.getConfigurationSetting({
      key,
      label: null,
    });
    if (typeof fallback.value === "string") {
      return fallback.value;
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  return "";
}

function isNotFound(error) {
  if (!error || typeof error !== "object") return false;
  const status = Number(error.statusCode || error.status || 0);
  return status === 404;
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}
