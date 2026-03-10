import { CosmosClient } from '@azure/cosmos';
import { BlobServiceClient } from '@azure/storage-blob';

const cosmosEndpoint = normalize(process.env.COSMOS_ENDPOINT);
const cosmosKey = normalize(process.env.COSMOS_KEY);
const cosmosDatabaseName = normalize(process.env.COSMOS_DATABASE_NAME) || 'suppliercompare';
const cosmosContainerName = normalize(process.env.COSMOS_CONTAINER_NAME) || 'appstate';
const cosmosTenant = normalize(process.env.APP_STORAGE_TENANT) || normalize(process.env.ENVIRONMENT) || 'default';
const cosmosDocumentId = normalize(process.env.APP_STORAGE_DOCUMENT_ID) || 'app-storage';

const blobConnectionString = normalize(process.env.APP_STORAGE_BLOB_CONNECTION_STRING);
const blobContainerName = normalize(process.env.APP_STORAGE_BLOB_CONTAINER) || 'appstate';
const blobName = normalize(process.env.APP_STORAGE_BLOB_NAME) || 'app-storage.json';

const hasCosmosConfig = Boolean(cosmosEndpoint && cosmosKey);
const hasBlobConfig = Boolean(blobConnectionString);

let inMemoryStore = {};
let lock = Promise.resolve();
let cosmosContainerClientPromise;
let blobClientPromise;

function withLock(task) {
  lock = lock.then(task, task);
  return lock;
}

export async function getStorageSnapshot() {
  return withLock(async () => readStore());
}

export async function setStorageValue(key, value) {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid storage key.');
  }

  return withLock(async () => {
    const store = await readStore();
    if (value === null || value === undefined) {
      delete store[key];
    } else {
      store[key] = String(value);
    }
    await writeStore(store);
  });
}

async function readStore() {
  if (hasCosmosConfig) {
    try {
      const store = await readFromCosmos();
      if (store) {
        if (Object.keys(store).length === 0 && hasBlobConfig) {
          const fallback = await readFromBlob();
          if (fallback && Object.keys(fallback).length > 0) {
            await writeToCosmos(fallback);
            inMemoryStore = fallback;
            return { ...fallback };
          }
        }
        inMemoryStore = store;
        return { ...store };
      }
    } catch (error) {
      console.warn(`Cosmos read failed, falling back: ${toErrorMessage(error)}`);
    }
  }

  if (hasBlobConfig) {
    try {
      const store = await readFromBlob();
      if (store) {
        inMemoryStore = store;
        return { ...store };
      }
    } catch (error) {
      console.warn(`Blob read failed, falling back: ${toErrorMessage(error)}`);
    }
  }

  return { ...inMemoryStore };
}

async function writeStore(store) {
  inMemoryStore = { ...store };

  const writeTasks = [];
  if (hasCosmosConfig) {
    writeTasks.push(writeToCosmos(store));
  }
  if (hasBlobConfig) {
    writeTasks.push(writeToBlob(store));
  }

  if (writeTasks.length === 0) {
    return;
  }

  const results = await Promise.allSettled(writeTasks);
  const failures = results.filter((entry) => entry.status === 'rejected');
  if (failures.length === 0) {
    return;
  }

  failures.forEach((failure) => {
    console.warn(`Storage write target failed: ${toErrorMessage(failure.reason)}`);
  });

  if (failures.length === results.length) {
    throw new Error('All storage backends failed to persist the update.');
  }
}

async function getCosmosContainerClient() {
  if (!hasCosmosConfig) return null;
  if (!cosmosContainerClientPromise) {
    cosmosContainerClientPromise = Promise.resolve().then(() => {
      const client = new CosmosClient({
        endpoint: cosmosEndpoint,
        key: cosmosKey,
      });
      return client.database(cosmosDatabaseName).container(cosmosContainerName);
    });
  }
  return cosmosContainerClientPromise;
}

async function readFromCosmos() {
  const container = await getCosmosContainerClient();
  if (!container) return null;

  try {
    const { resource } = await container.item(cosmosDocumentId, cosmosTenant).read();
    return sanitizeStore(resource?.data);
  } catch (error) {
    if (isNotFound(error)) {
      return {};
    }
    throw error;
  }
}

async function writeToCosmos(store) {
  const container = await getCosmosContainerClient();
  if (!container) return;

  await container.items.upsert({
    id: cosmosDocumentId,
    tenant: cosmosTenant,
    data: store,
    updatedAt: new Date().toISOString(),
  });
}

async function getBlobClient() {
  if (!hasBlobConfig) return null;
  if (!blobClientPromise) {
    blobClientPromise = Promise.resolve().then(async () => {
      const serviceClient = BlobServiceClient.fromConnectionString(blobConnectionString);
      const containerClient = serviceClient.getContainerClient(blobContainerName);
      await containerClient.createIfNotExists();
      return containerClient.getBlockBlobClient(blobName);
    });
  }
  return blobClientPromise;
}

async function readFromBlob() {
  const blobClient = await getBlobClient();
  if (!blobClient) return null;

  try {
    const download = await blobClient.download(0);
    const raw = await streamToString(download.readableStreamBody);
    if (!raw) return {};
    return sanitizeStore(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) {
      return {};
    }
    throw error;
  }
}

async function writeToBlob(store) {
  const blobClient = await getBlobClient();
  if (!blobClient) return;

  const payload = JSON.stringify(store);
  await blobClient.upload(payload, Buffer.byteLength(payload), {
    blobHTTPHeaders: {
      blobContentType: 'application/json',
    },
  });
}

function sanitizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, String(entryValue)])
  );
}

function isNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  const status = Number(error.statusCode || error.status || 0);
  return status === 404;
}

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown error');
}

function streamToString(stream) {
  if (!stream) {
    return Promise.resolve('');
  }

  return new Promise((resolve, reject) => {
    let data = '';
    stream.on('data', (chunk) => {
      data += chunk.toString();
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}
