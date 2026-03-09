import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const storageFile = process.env.APP_STORAGE_FILE
  ? path.resolve(projectRoot, process.env.APP_STORAGE_FILE)
  : path.join(projectRoot, 'data', 'app-storage.json');

let lock = Promise.resolve();

function withLock(task) {
  lock = lock.then(task, task);
  return lock;
}

async function readStore() {
  try {
    const raw = await readFile(storageFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeStore(store) {
  await mkdir(path.dirname(storageFile), { recursive: true });
  await writeFile(storageFile, JSON.stringify(store), 'utf-8');
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

