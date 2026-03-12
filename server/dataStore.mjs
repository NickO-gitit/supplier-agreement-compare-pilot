import { CosmosClient } from '@azure/cosmos';

const cosmosEndpoint = normalize(process.env.COSMOS_ENDPOINT);
const cosmosKey = normalize(process.env.COSMOS_KEY);
const cosmosDatabaseName = normalize(process.env.COSMOS_DATABASE_NAME) || 'suppliercompare';
const cosmosContainerName = normalize(process.env.COSMOS_CONTAINER_NAME) || 'projects';
const cosmosTenant = normalize(process.env.APP_STORAGE_TENANT) || normalize(process.env.ENVIRONMENT) || 'default';
const cosmosLegacyDocumentId = normalize(process.env.APP_STORAGE_DOCUMENT_ID) || 'app-storage';

const hasCosmosConfig = Boolean(cosmosEndpoint && cosmosKey);

const PROJECTS_KEY = 'supplier-agreement-projects';
const PROJECT_COMPARISONS_PREFIX = 'supplier-agreement-comparisons:project:';
const PROJECT_NOTES_PREFIX = 'supplier-agreement-notes:project:';
const PROJECT_CHANGE_RESPONSES_PREFIX = 'supplier-agreement-change-responses:project:';
const LEGACY_CUSTOMERS_KEY = 'supplier-agreement-customers';
const LEGACY_COMPARISONS_KEY = 'supplier-agreement-comparisons';

const PROJECT_DOC_TYPE = 'project';
const RUN_DOC_TYPE = 'run';
const CONFIG_DOC_TYPE = 'config';
const SYSTEM_PROJECT_ID = '__system';

let lock = Promise.resolve();
let cosmosContainerClientPromise;

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
    const container = await getCosmosContainerClient();
    const state = await loadState(container);
    applyMutation(state, key, value);
    await persistState(container, state);
  });
}

async function readStore() {
  const container = await getCosmosContainerClient();
  const state = await loadState(container);

  if (state.projectsById.size === 0 && Object.keys(state.configValues).length === 0) {
    const legacy = await readLegacySnapshot(container);
    if (legacy) {
      return legacy;
    }
  }

  return buildSnapshotFromState(state);
}

async function getCosmosContainerClient() {
  if (!hasCosmosConfig) {
    throw new Error('Cosmos DB is required. Set COSMOS_ENDPOINT and COSMOS_KEY.');
  }

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

async function queryTypedDocuments(container) {
  const querySpec = {
    query: `
      SELECT * FROM c
      WHERE c.tenant = @tenant
      AND c.type IN (@projectType, @runType, @configType)
    `,
    parameters: [
      { name: '@tenant', value: cosmosTenant },
      { name: '@projectType', value: PROJECT_DOC_TYPE },
      { name: '@runType', value: RUN_DOC_TYPE },
      { name: '@configType', value: CONFIG_DOC_TYPE },
    ],
  };

  const { resources } = await container.items
    .query(querySpec, { enableCrossPartitionQuery: true })
    .fetchAll();

  return resources || [];
}

async function readLegacySnapshot(container) {
  try {
    const { resource } = await container.item(cosmosLegacyDocumentId, cosmosTenant).read();
    if (!resource || typeof resource.data !== 'object' || Array.isArray(resource.data)) {
      return null;
    }

    return sanitizeStore(resource.data);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function createEmptyState() {
  return {
    projectsById: new Map(),
    configValues: {},
    removedProjectIds: new Set(),
    modifiedProjectIds: new Set(),
    configTouched: false,
    canonicalConfigDocPresent: false,
    legacyRunDocs: [],
    legacyConfigDocs: [],
  };
}

async function loadState(container) {
  const docs = await queryTypedDocuments(container);
  const state = createEmptyState();

  docs.forEach((doc) => {
    const type = String(doc?.type || '').trim();

    if (type === PROJECT_DOC_TYPE) {
      const projectId = String(doc?.projectId || '').trim();
      if (!projectId || projectId === SYSTEM_PROJECT_ID) {
        return;
      }

      const projectTable = normalizeProjectTable(doc.projectTable, doc, projectId);
      const runTable = normalizeRunTable(doc.runTable, projectId);

      state.projectsById.set(projectId, {
        projectId,
        doc,
        projectTable,
        runTable,
      });
      return;
    }

    if (type === RUN_DOC_TYPE) {
      state.legacyRunDocs.push(doc);
      return;
    }

    if (type === CONFIG_DOC_TYPE) {
      if (doc.id === buildConfigDocumentId()) {
        state.canonicalConfigDocPresent = true;
        if (doc.values && typeof doc.values === 'object' && !Array.isArray(doc.values)) {
          Object.entries(doc.values).forEach(([key, value]) => {
            state.configValues[key] = String(value);
          });
        }
      } else if (typeof doc.key === 'string' && typeof doc.value === 'string') {
        state.configValues[doc.key] = doc.value;
        state.legacyConfigDocs.push(doc);
      } else {
        state.legacyConfigDocs.push(doc);
      }
    }
  });

  // Migrate prior structure: one run document per comparison -> embed under project.runTable
  state.legacyRunDocs.forEach((runDoc) => {
    const projectId = String(runDoc?.projectId || '').trim();
    if (!projectId || projectId === SYSTEM_PROJECT_ID) {
      return;
    }

    const projectState = ensureProjectState(state, projectId, projectId);
    const runId = String(runDoc?.runId || runDoc?.comparison?.id || '').trim();
    if (!runId) {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(projectState.runTable, runId)) {
      projectState.runTable[runId] = normalizeRunRecord(runDoc, projectId, runId);
      state.modifiedProjectIds.add(projectId);
    }
  });

  if (state.legacyRunDocs.length > 0 || state.legacyConfigDocs.length > 0) {
    state.configTouched = true;
  }

  return state;
}

function buildSnapshotFromState(state) {
  const snapshot = {};

  const projects = Array.from(state.projectsById.values())
    .map((entry) => entry.projectTable)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  if (projects.length > 0) {
    snapshot[PROJECTS_KEY] = JSON.stringify(projects);
  }

  state.projectsById.forEach((entry, projectId) => {
    const runList = Object.values(entry.runTable)
      .map((run) => normalizeComparison(run.comparison, projectId, run.runId))
      .filter((comparison) => comparison.id)
      .sort(
        (a, b) =>
          new Date(String(b.createdAt || 0)).getTime() -
          new Date(String(a.createdAt || 0)).getTime()
      );

    if (runList.length > 0) {
      snapshot[`${PROJECT_COMPARISONS_PREFIX}${projectId}`] = JSON.stringify(runList);
    }

    const notesByComparison = {};
    const responsesByComparison = {};

    Object.entries(entry.runTable).forEach(([runId, run]) => {
      if (Array.isArray(run.notes) && run.notes.length > 0) {
        notesByComparison[runId] = run.notes;
      }
      if (Array.isArray(run.changeResponses) && run.changeResponses.length > 0) {
        responsesByComparison[runId] = run.changeResponses;
      }
    });

    if (Object.keys(notesByComparison).length > 0) {
      snapshot[`${PROJECT_NOTES_PREFIX}${projectId}`] = JSON.stringify(notesByComparison);
    }

    if (Object.keys(responsesByComparison).length > 0) {
      snapshot[`${PROJECT_CHANGE_RESPONSES_PREFIX}${projectId}`] = JSON.stringify(responsesByComparison);
    }
  });

  Object.entries(state.configValues).forEach(([key, value]) => {
    snapshot[key] = String(value);
  });

  return snapshot;
}

function applyMutation(state, key, value) {
  if (key === PROJECTS_KEY || key === LEGACY_CUSTOMERS_KEY) {
    applyProjectsKey(state, value);
    return;
  }

  if (key.startsWith(PROJECT_COMPARISONS_PREFIX)) {
    const projectId = key.slice(PROJECT_COMPARISONS_PREFIX.length).trim();
    applyProjectComparisonsKey(state, projectId, value);
    return;
  }

  if (key === LEGACY_COMPARISONS_KEY) {
    applyLegacyComparisonsKey(state, value);
    return;
  }

  if (key.startsWith(PROJECT_NOTES_PREFIX)) {
    const projectId = key.slice(PROJECT_NOTES_PREFIX.length).trim();
    applyProjectNotesKey(state, projectId, value);
    return;
  }

  if (key.startsWith(PROJECT_CHANGE_RESPONSES_PREFIX)) {
    const projectId = key.slice(PROJECT_CHANGE_RESPONSES_PREFIX.length).trim();
    applyProjectChangeResponsesKey(state, projectId, value);
    return;
  }

  applyConfigKey(state, key, value);
}

function applyProjectsKey(state, value) {
  const projects = parseProjectsValue(value);
  const incomingIds = new Set(projects.map((entry) => entry.id));

  projects.forEach((project) => {
    const projectState = ensureProjectState(state, project.id, project.name);

    projectState.projectTable = {
      id: project.id,
      name: project.name,
      color: project.color,
      initials: project.initials,
      createdAt: project.createdAt || projectState.projectTable.createdAt || new Date().toISOString(),
    };

    state.modifiedProjectIds.add(project.id);
  });

  Array.from(state.projectsById.keys()).forEach((projectId) => {
    if (!incomingIds.has(projectId)) {
      state.projectsById.delete(projectId);
      state.removedProjectIds.add(projectId);
      state.modifiedProjectIds.delete(projectId);
    }
  });
}

function applyProjectComparisonsKey(state, projectId, value) {
  if (!projectId) return;

  const comparisons = parseComparisonsValue(value, projectId);
  const projectState = ensureProjectState(state, projectId, projectId);
  const now = new Date().toISOString();

  const nextRunTable = {};

  comparisons.forEach((comparison) => {
    const runId = comparison.id;
    if (!runId) return;

    const existing = projectState.runTable[runId];
    nextRunTable[runId] = {
      runId,
      createdAt: existing?.createdAt || comparison.createdAt || now,
      updatedAt: now,
      comparison: normalizeComparison(comparison, projectId, runId),
      notes: Array.isArray(existing?.notes) ? existing.notes : [],
      changeResponses: Array.isArray(existing?.changeResponses) ? existing.changeResponses : [],
    };
  });

  projectState.runTable = nextRunTable;
  state.modifiedProjectIds.add(projectId);
}

function applyLegacyComparisonsKey(state, value) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return;
  }

  const grouped = new Map();

  parsed.forEach((entry) => {
    const normalized = normalizeComparison(entry, '', '');
    if (!normalized.projectId || !normalized.id) {
      return;
    }

    const list = grouped.get(normalized.projectId) || [];
    list.push(normalized);
    grouped.set(normalized.projectId, list);
  });

  grouped.forEach((comparisons, projectId) => {
    applyProjectComparisonsKey(state, projectId, JSON.stringify(comparisons));
  });
}

function applyProjectNotesKey(state, projectId, value) {
  if (!projectId) return;

  const notesByComparison = parseJsonObject(value);
  const projectState = ensureProjectState(state, projectId, projectId);
  const now = new Date().toISOString();

  Object.entries(projectState.runTable).forEach(([runId, run]) => {
    const notes = Array.isArray(notesByComparison?.[runId]) ? notesByComparison[runId] : [];
    run.notes = notes;
    run.updatedAt = now;
  });

  state.modifiedProjectIds.add(projectId);
}

function applyProjectChangeResponsesKey(state, projectId, value) {
  if (!projectId) return;

  const responsesByComparison = parseJsonObject(value);
  const projectState = ensureProjectState(state, projectId, projectId);
  const now = new Date().toISOString();

  Object.entries(projectState.runTable).forEach(([runId, run]) => {
    const responses = Array.isArray(responsesByComparison?.[runId])
      ? responsesByComparison[runId]
      : [];

    run.changeResponses = responses;
    run.updatedAt = now;
  });

  state.modifiedProjectIds.add(projectId);
}

function applyConfigKey(state, key, value) {
  if (value === null || value === undefined) {
    delete state.configValues[key];
  } else {
    state.configValues[key] = String(value);
  }

  state.configTouched = true;
}

async function persistState(container, state) {
  const now = new Date().toISOString();

  // Upsert modified project documents.
  for (const projectId of state.modifiedProjectIds) {
    const projectState = state.projectsById.get(projectId);
    if (!projectState) continue;

    const doc = {
      id: buildProjectDocumentId(projectId),
      type: PROJECT_DOC_TYPE,
      tenant: cosmosTenant,
      projectId,
      projectTable: projectState.projectTable,
      runTable: projectState.runTable,
      runCount: Object.keys(projectState.runTable).length,
      createdAt: projectState.doc?.createdAt || projectState.projectTable.createdAt || now,
      updatedAt: now,
    };

    await container.items.upsert(doc);
  }

  // Delete removed project documents.
  for (const projectId of state.removedProjectIds) {
    await deleteById(container, buildProjectDocumentId(projectId), [projectId, cosmosTenant]);
  }

  // Persist config values in one canonical system document.
  const configDocId = buildConfigDocumentId();
  if (Object.keys(state.configValues).length > 0) {
    await container.items.upsert({
      id: configDocId,
      type: CONFIG_DOC_TYPE,
      tenant: cosmosTenant,
      projectId: SYSTEM_PROJECT_ID,
      values: state.configValues,
      updatedAt: now,
    });
  } else if (state.configTouched || state.canonicalConfigDocPresent) {
    await deleteById(container, configDocId, [SYSTEM_PROJECT_ID, cosmosTenant]);
  }

  // Cleanup legacy run/config records from prior schema versions.
  for (const runDoc of state.legacyRunDocs) {
    await deleteDocument(container, runDoc);
  }

  for (const configDoc of state.legacyConfigDocs) {
    await deleteDocument(container, configDoc);
  }

  // Cleanup legacy single snapshot doc after successful migration.
  if (state.modifiedProjectIds.size > 0 || state.legacyRunDocs.length > 0 || state.configTouched) {
    await deleteById(container, cosmosLegacyDocumentId, [cosmosTenant, SYSTEM_PROJECT_ID]);
  }
}

function ensureProjectState(state, projectId, fallbackName) {
  const existing = state.projectsById.get(projectId);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const created = {
    projectId,
    doc: null,
    projectTable: {
      id: projectId,
      name: fallbackName || projectId,
      color: 'blue',
      initials: deriveInitials(fallbackName || projectId),
      createdAt: now,
    },
    runTable: {},
  };

  state.projectsById.set(projectId, created);
  state.modifiedProjectIds.add(projectId);
  return created;
}

function normalizeProjectTable(value, doc, projectId) {
  const now = new Date().toISOString();

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      id: String(value.id || projectId),
      name: String(value.name || doc?.name || projectId),
      color: String(value.color || doc?.color || 'blue'),
      initials: String(value.initials || doc?.initials || deriveInitials(String(value.name || doc?.name || projectId))),
      createdAt: value.createdAt || doc?.createdAt || now,
    };
  }

  return {
    id: projectId,
    name: String(doc?.name || projectId),
    color: String(doc?.color || 'blue'),
    initials: String(doc?.initials || deriveInitials(String(doc?.name || projectId))),
    createdAt: doc?.createdAt || now,
  };
}

function normalizeRunTable(runTableValue, projectId) {
  const runTable = {};

  if (!runTableValue || typeof runTableValue !== 'object' || Array.isArray(runTableValue)) {
    return runTable;
  }

  Object.entries(runTableValue).forEach(([runId, entry]) => {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) return;

    runTable[normalizedRunId] = normalizeRunRecord(entry, projectId, normalizedRunId);
  });

  return runTable;
}

function normalizeRunRecord(value, projectId, runId) {
  const record = sanitizeObject(value);
  const now = new Date().toISOString();

  const comparisonSource = record.comparison || record;
  const comparison = normalizeComparison(comparisonSource, projectId, runId);

  return {
    runId,
    createdAt: record.createdAt || comparison.createdAt || now,
    updatedAt: record.updatedAt || now,
    comparison,
    notes: Array.isArray(record.notes) ? record.notes : [],
    changeResponses: Array.isArray(record.changeResponses) ? record.changeResponses : [],
  };
}

function normalizeComparison(value, defaultProjectId, defaultId) {
  const source = sanitizeObject(value);
  const id =
    (typeof source.id === 'string' && source.id.trim()) ||
    (typeof defaultId === 'string' && defaultId.trim()) ||
    '';
  const projectId =
    (typeof source.projectId === 'string' && source.projectId.trim()) ||
    (typeof source.customerId === 'string' && source.customerId.trim()) ||
    (typeof defaultProjectId === 'string' && defaultProjectId.trim()) ||
    '';

  return {
    ...source,
    id,
    projectId,
    title:
      typeof source.title === 'string' && source.title.trim().length > 0
        ? source.title
        : null,
    createdAt: source.createdAt || new Date().toISOString(),
  };
}

function parseProjectsValue(value) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) return null;

      const name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : id;

      return {
        id,
        name,
        color: typeof entry?.color === 'string' && entry.color.trim() ? entry.color.trim() : 'blue',
        initials:
          typeof entry?.initials === 'string' && entry.initials.trim()
            ? entry.initials.trim()
            : deriveInitials(name),
        createdAt:
          typeof entry?.createdAt === 'string' || typeof entry?.createdAt === 'number'
            ? entry.createdAt
            : new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function parseComparisonsValue(value, projectId) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => normalizeComparison(entry, projectId, ''))
    .filter((entry) => entry.id && entry.projectId);
}

function buildProjectDocumentId(projectId) {
  return `project:${projectId}`;
}

function buildConfigDocumentId() {
  return `config:${cosmosTenant}`;
}

async function deleteById(container, id, partitionKeyCandidates) {
  let lastError = null;

  for (const partitionKey of partitionKeyCandidates) {
    try {
      await container.item(id, partitionKey).delete();
      return;
    } catch (error) {
      if (isNotFound(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastError && !isNotFound(lastError)) {
    throw lastError;
  }
}

async function deleteDocument(container, doc) {
  const candidates = Array.from(
    new Set([doc?.projectId, doc?.tenant, SYSTEM_PROJECT_ID, cosmosTenant].filter(Boolean))
  );
  await deleteById(container, doc.id, candidates);
}

function sanitizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, String(entryValue)])
  );
}

function sanitizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value;
}

function parseJsonObject(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function deriveInitials(name) {
  const tokens = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return `${tokens[0][0] || ''}${tokens[1][0] || ''}`.toUpperCase();
}

function isNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  const status = Number(error.statusCode || error.status || 0);
  return status === 404;
}

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}
