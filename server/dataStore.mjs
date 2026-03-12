import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const cosmosEndpoint = normalize(process.env.COSMOS_ENDPOINT);
const managedIdentityClientId = normalize(process.env.AZURE_CLIENT_ID);
const cosmosDatabaseName = normalize(process.env.COSMOS_DATABASE_NAME) || 'suppliercompare';
const cosmosContainerName = normalize(process.env.COSMOS_CONTAINER_NAME) || 'projects';
const cosmosTenant = normalize(process.env.APP_STORAGE_TENANT) || normalize(process.env.ENVIRONMENT) || 'default';
const cosmosLegacyDocumentId = normalize(process.env.APP_STORAGE_DOCUMENT_ID) || 'app-storage';

const hasCosmosConfig = Boolean(cosmosEndpoint);

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
  return withLock(async () => {
    const container = await getCosmosContainerClient();
    const state = await loadState(container);
    return buildSnapshotFromState(state);
  });
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

async function getCosmosContainerClient() {
  if (!hasCosmosConfig) {
    throw new Error('Cosmos DB is required. Set COSMOS_ENDPOINT.');
  }

  if (!cosmosContainerClientPromise) {
    cosmosContainerClientPromise = Promise.resolve().then(() => {
      const credential = managedIdentityClientId
        ? new DefaultAzureCredential({ managedIdentityClientId })
        : new DefaultAzureCredential();

      const client = new CosmosClient({
        endpoint: cosmosEndpoint,
        aadCredentials: credential,
      });

      return client.database(cosmosDatabaseName).container(cosmosContainerName);
    });
  }

  return cosmosContainerClientPromise;
}

function createEmptyState() {
  return {
    projectsById: new Map(),
    runsByProject: new Map(),
    configValues: {},

    existingProjectDocs: new Map(),
    existingRunDocs: new Map(),
    legacyConfigDocs: [],

    hadLegacySnapshot: false,
    changed: false,
  };
}

async function loadState(container) {
  const state = createEmptyState();
  const typedDocs = await queryTypedDocuments(container);

  typedDocs.forEach((doc) => {
    const type = String(doc?.type || '').trim();

    if (type === PROJECT_DOC_TYPE) {
      const projectId = String(doc?.projectId || doc?.project || '').trim();
      if (!projectId || projectId === SYSTEM_PROJECT_ID) {
        return;
      }

      state.existingProjectDocs.set(projectId, doc);
      state.projectsById.set(projectId, normalizeProject(doc, projectId));

      // Migration support from previously embedded model.
      if (doc.runTable && typeof doc.runTable === 'object' && !Array.isArray(doc.runTable)) {
        const runs = state.runsByProject.get(projectId) || new Map();
        Object.entries(doc.runTable).forEach(([runId, runValue]) => {
          const normalizedRunId = String(runId || '').trim();
          if (!normalizedRunId) return;
          if (!runs.has(normalizedRunId)) {
            runs.set(normalizedRunId, normalizeRunRecord(runValue, projectId, normalizedRunId));
          }
        });
        state.runsByProject.set(projectId, runs);
      }

      return;
    }

    if (type === RUN_DOC_TYPE) {
      const projectId = String(doc?.projectId || doc?.project || '').trim();
      const runId = String(doc?.runId || doc?.comparison?.id || '').trim();
      if (!projectId || !runId || projectId === SYSTEM_PROJECT_ID) {
        return;
      }

      state.existingRunDocs.set(buildRunDocumentId(projectId, runId), doc);

      const runs = state.runsByProject.get(projectId) || new Map();
      runs.set(runId, normalizeRunRecord(doc, projectId, runId));
      state.runsByProject.set(projectId, runs);

      if (!state.projectsById.has(projectId)) {
        state.projectsById.set(projectId, {
          id: projectId,
          name: projectId,
          color: 'blue',
          initials: deriveInitials(projectId),
          createdAt: doc?.createdAt || new Date().toISOString(),
        });
      }

      return;
    }

    if (type === CONFIG_DOC_TYPE) {
      if (doc.id === buildConfigDocumentId()) {
        if (doc.values && typeof doc.values === 'object' && !Array.isArray(doc.values)) {
          Object.entries(doc.values).forEach(([k, v]) => {
            state.configValues[k] = String(v);
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

  if (typedDocs.length === 0) {
    const legacySnapshot = await readLegacySnapshot(container);
    if (legacySnapshot) {
      state.hadLegacySnapshot = true;
      applySnapshotToState(state, legacySnapshot);
      state.changed = true;
    }
  }

  return state;
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

function applySnapshotToState(state, snapshot) {
  const keys = Object.keys(snapshot || {});

  keys
    .filter((key) => key === PROJECTS_KEY || key === LEGACY_CUSTOMERS_KEY)
    .forEach((key) => applyMutation(state, key, snapshot[key]));

  keys
    .filter(
      (key) =>
        key.startsWith(PROJECT_COMPARISONS_PREFIX) ||
        key === LEGACY_COMPARISONS_KEY
    )
    .forEach((key) => applyMutation(state, key, snapshot[key]));

  keys
    .filter((key) => key.startsWith(PROJECT_NOTES_PREFIX))
    .forEach((key) => applyMutation(state, key, snapshot[key]));

  keys
    .filter((key) => key.startsWith(PROJECT_CHANGE_RESPONSES_PREFIX))
    .forEach((key) => applyMutation(state, key, snapshot[key]));

  keys
    .filter(
      (key) =>
        key !== PROJECTS_KEY &&
        key !== LEGACY_CUSTOMERS_KEY &&
        !key.startsWith(PROJECT_COMPARISONS_PREFIX) &&
        key !== LEGACY_COMPARISONS_KEY &&
        !key.startsWith(PROJECT_NOTES_PREFIX) &&
        !key.startsWith(PROJECT_CHANGE_RESPONSES_PREFIX)
    )
    .forEach((key) => applyMutation(state, key, snapshot[key]));
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
  const desiredIds = new Set(projects.map((p) => p.id));

  projects.forEach((project) => {
    const current = state.projectsById.get(project.id);
    state.projectsById.set(project.id, {
      ...current,
      ...project,
      createdAt: project.createdAt || current?.createdAt || new Date().toISOString(),
    });

    if (!state.runsByProject.has(project.id)) {
      state.runsByProject.set(project.id, new Map());
    }
  });

  Array.from(state.projectsById.keys()).forEach((projectId) => {
    if (!desiredIds.has(projectId)) {
      state.projectsById.delete(projectId);
      state.runsByProject.delete(projectId);
    }
  });

  state.changed = true;
}

function applyProjectComparisonsKey(state, projectId, value) {
  if (!projectId) return;

  const comparisons = parseComparisonsValue(value, projectId);
  const existingRuns = state.runsByProject.get(projectId) || new Map();
  const nextRuns = new Map();
  const now = new Date().toISOString();

  comparisons.forEach((comparison) => {
    const runId = comparison.id;
    if (!runId) return;

    const existing = existingRuns.get(runId);
    nextRuns.set(runId, {
      runId,
      createdAt: existing?.createdAt || comparison.createdAt || now,
      updatedAt: now,
      comparison: normalizeComparison(comparison, projectId, runId),
      notes: Array.isArray(existing?.notes) ? existing.notes : [],
      changeResponses: Array.isArray(existing?.changeResponses) ? existing.changeResponses : [],
    });
  });

  state.runsByProject.set(projectId, nextRuns);

  if (!state.projectsById.has(projectId)) {
    state.projectsById.set(projectId, {
      id: projectId,
      name: projectId,
      color: 'blue',
      initials: deriveInitials(projectId),
      createdAt: now,
    });
  }

  state.changed = true;
}

function applyLegacyComparisonsKey(state, value) {
  const parsed = parseJsonObject(value);
  if (!Array.isArray(parsed)) {
    return;
  }

  const grouped = new Map();
  parsed.forEach((entry) => {
    const comparison = normalizeComparison(entry, '', '');
    if (!comparison.projectId || !comparison.id) return;

    const list = grouped.get(comparison.projectId) || [];
    list.push(comparison);
    grouped.set(comparison.projectId, list);
  });

  grouped.forEach((comparisons, projectId) => {
    applyProjectComparisonsKey(state, projectId, JSON.stringify(comparisons));
  });
}

function applyProjectNotesKey(state, projectId, value) {
  if (!projectId) return;

  const notesByComparison = parseJsonObject(value);
  const runs = state.runsByProject.get(projectId) || new Map();
  const now = new Date().toISOString();

  runs.forEach((run, runId) => {
    run.notes = Array.isArray(notesByComparison?.[runId]) ? notesByComparison[runId] : [];
    run.updatedAt = now;
  });

  state.runsByProject.set(projectId, runs);
  state.changed = true;
}

function applyProjectChangeResponsesKey(state, projectId, value) {
  if (!projectId) return;

  const responsesByComparison = parseJsonObject(value);
  const runs = state.runsByProject.get(projectId) || new Map();
  const now = new Date().toISOString();

  runs.forEach((run, runId) => {
    run.changeResponses = Array.isArray(responsesByComparison?.[runId])
      ? responsesByComparison[runId]
      : [];
    run.updatedAt = now;
  });

  state.runsByProject.set(projectId, runs);
  state.changed = true;
}

function applyConfigKey(state, key, value) {
  if (value === null || value === undefined) {
    delete state.configValues[key];
  } else {
    state.configValues[key] = String(value);
  }

  state.changed = true;
}

async function persistState(container, state) {
  if (!state.changed) {
    return;
  }

  const now = new Date().toISOString();

  // Upsert project documents.
  for (const [projectId, project] of state.projectsById.entries()) {
    const existing = state.existingProjectDocs.get(projectId);

      await container.items.upsert({
        id: buildProjectDocumentId(projectId),
        type: PROJECT_DOC_TYPE,
        tenant: cosmosTenant,
        projectId,
        project: projectId,
        name: project.name,
        color: project.color,
        initials: project.initials,
        createdAt: existing?.createdAt || project.createdAt || now,
        updatedAt: now,
      });
  }

  // Delete project documents removed from state.
  for (const [projectId] of state.existingProjectDocs.entries()) {
    if (!state.projectsById.has(projectId)) {
      await deleteById(container, buildProjectDocumentId(projectId), [projectId, cosmosTenant]);
    }
  }

  // Upsert run documents.
  const desiredRunDocIds = new Set();

  for (const [projectId, runs] of state.runsByProject.entries()) {
    for (const [runId, run] of runs.entries()) {
      const docId = buildRunDocumentId(projectId, runId);
      desiredRunDocIds.add(docId);
      const existing = state.existingRunDocs.get(docId);

      await container.items.upsert({
        id: docId,
        type: RUN_DOC_TYPE,
        tenant: cosmosTenant,
        projectId,
        project: projectId,
        runId,
        comparison: normalizeComparison(run.comparison, projectId, runId),
        notes: Array.isArray(run.notes) ? run.notes : [],
        changeResponses: Array.isArray(run.changeResponses) ? run.changeResponses : [],
        createdAt: existing?.createdAt || run.createdAt || now,
        updatedAt: now,
      });
    }
  }

  // Delete run documents removed from state.
  for (const [docId, doc] of state.existingRunDocs.entries()) {
    if (!desiredRunDocIds.has(docId)) {
      await deleteDocument(container, doc);
    }
  }

  // Persist config values as one canonical config doc.
  const configDocId = buildConfigDocumentId();
  if (Object.keys(state.configValues).length > 0) {
    await container.items.upsert({
      id: configDocId,
      type: CONFIG_DOC_TYPE,
      tenant: cosmosTenant,
      projectId: SYSTEM_PROJECT_ID,
      project: SYSTEM_PROJECT_ID,
      values: state.configValues,
      updatedAt: now,
    });
  } else {
    await deleteById(container, configDocId, [SYSTEM_PROJECT_ID, cosmosTenant]);
  }

  // Remove legacy config docs (key/value style).
  for (const legacyConfigDoc of state.legacyConfigDocs) {
    await deleteDocument(container, legacyConfigDoc);
  }

  // Remove old single-snapshot document after migration/write.
  if (state.hadLegacySnapshot) {
    await deleteById(container, cosmosLegacyDocumentId, [cosmosTenant, SYSTEM_PROJECT_ID]);
  }
}

function buildSnapshotFromState(state) {
  const snapshot = {};

  const projectIds = new Set([...state.projectsById.keys(), ...state.runsByProject.keys()]);

  const projects = Array.from(projectIds)
    .map((projectId) => {
      const project = state.projectsById.get(projectId);
      if (project) return project;

      return {
        id: projectId,
        name: projectId,
        color: 'blue',
        initials: deriveInitials(projectId),
        createdAt: new Date().toISOString(),
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  if (projects.length > 0) {
    snapshot[PROJECTS_KEY] = JSON.stringify(projects);
  }

  for (const projectId of projectIds) {
    const runs = state.runsByProject.get(projectId) || new Map();

    const comparisons = Array.from(runs.values())
      .map((run) => normalizeComparison(run.comparison, projectId, run.runId))
      .filter((comparison) => comparison.id)
      .sort(
        (a, b) =>
          new Date(String(b.createdAt || 0)).getTime() -
          new Date(String(a.createdAt || 0)).getTime()
      );

    if (comparisons.length > 0) {
      snapshot[`${PROJECT_COMPARISONS_PREFIX}${projectId}`] = JSON.stringify(comparisons);
    }

    const notesByComparison = {};
    const responsesByComparison = {};

    runs.forEach((run, runId) => {
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
  }

  Object.entries(state.configValues).forEach(([key, value]) => {
    snapshot[key] = String(value);
  });

  return snapshot;
}

function normalizeProject(doc, projectId) {
  const source =
    doc?.projectTable && typeof doc.projectTable === 'object' && !Array.isArray(doc.projectTable)
      ? doc.projectTable
      : doc;

  const name = String(source?.name || doc?.name || projectId);

  return {
    id: String(source?.id || projectId),
    name,
    color: String(source?.color || doc?.color || 'blue'),
    initials: String(source?.initials || doc?.initials || deriveInitials(name)),
    createdAt: source?.createdAt || doc?.createdAt || new Date().toISOString(),
  };
}

function normalizeRunRecord(value, projectId, runId) {
  const source = sanitizeObject(value);
  const now = new Date().toISOString();

  const comparisonSource = source.comparison || source;
  const comparison = normalizeComparison(comparisonSource, projectId, runId);

  return {
    runId,
    createdAt: source.createdAt || comparison.createdAt || now,
    updatedAt: source.updatedAt || now,
    comparison,
    notes: Array.isArray(source.notes) ? source.notes : [],
    changeResponses: Array.isArray(source.changeResponses) ? source.changeResponses : [],
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

function buildRunDocumentId(projectId, runId) {
  return `run:${projectId}:${runId}`;
}

function buildConfigDocumentId() {
  return `config:${cosmosTenant}`;
}

async function deleteById(container, id, partitionKeyCandidates) {
  const candidates = Array.from(new Set(partitionKeyCandidates.filter(Boolean)));

  let lastError = null;
  for (const partitionKey of candidates) {
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
  await deleteById(container, doc.id, [
    doc?.projectId,
    doc?.project,
    doc?.tenant,
    SYSTEM_PROJECT_ID,
    cosmosTenant,
  ]);
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
