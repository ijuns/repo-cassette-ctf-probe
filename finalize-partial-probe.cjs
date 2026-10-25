module.exports = async function finalizePartialProbe({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsOrigin = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(item => item.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const service = `${resultsOrigin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const body = Buffer.from('{"probe":"finalize-partial","owner":{"avatar_url":"https://example.com/"}}');
  const cases = [
    ['negative-size', {size: '-1'}],
    ['mismatch-size', {size: String(body.length + 1)}],
    ['wrong-sha256', {size: String(body.length), hash: `sha256:${'0'.repeat(64)}`}],
    ['invalid-hash', {size: String(body.length), hash: 'not-a-digest'}],
  ];

  async function twirp(method, payload) {
    const response = await fetch(service + method, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    return {status: response.status, data};
  }

  async function list(name) {
    const result = await twirp('ListArtifacts', {...ids, name_filter: name});
    const matches = (result.data.artifacts || []).filter(item => item.name === name);
    return {status: result.status, ids: matches.map(item => String(item.database_id || item.databaseId || '')).filter(Boolean)};
  }

  async function signed(name) {
    const result = await twirp('GetSignedArtifactURL', {...ids, name});
    const url = result.data.signed_url || result.data.signedUrl;
    return {status: result.status, rsct: url ? new URL(url).searchParams.get('rsct') : null};
  }

  async function rest(artifactId) {
    const url = `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${artifactId}/zip`;
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
    });
    const location = response.headers.get('location');
    return {status: response.status, rsct: location ? new URL(location).searchParams.get('rsct') : null};
  }

  for (const [label, variation] of cases) {
    const name = `finalize-partial-${context.runId}-${label}`;
    const created = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
    const uploadUrl = created.data.signed_upload_url || created.data.signedUploadUrl;
    if (!uploadUrl) {
      console.log('CASE', JSON.stringify({label, createStatus: created.status, created: false}));
      continue;
    }
    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': 'application/json\u0085',
        'Content-Length': String(body.length),
      },
      body,
    });
    if (!uploaded.ok) {
      console.log('CASE', JSON.stringify({label, createStatus: created.status, uploadStatus: uploaded.status}));
      continue;
    }

    const before = await list(name);
    const beforeSigned = await signed(name);
    const finalized = await twirp('FinalizeArtifact', {...ids, name, ...variation});
    const responseId = String(finalized.data.artifact_id || finalized.data.artifactId || '');
    const immediate = await list(name);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const delayed = await list(name);
    const afterSigned = await signed(name);
    const allIds = [...new Set([responseId, ...immediate.ids, ...delayed.ids].filter(Boolean))];
    const restStates = [];
    for (const id of allIds) restStates.push({id, ...(await rest(id))});
    console.log('CASE', JSON.stringify({
      label,
      createStatus: created.status,
      uploadStatus: uploaded.status,
      before,
      beforeSigned,
      finalizeStatus: finalized.status,
      finalizeOk: Boolean(finalized.data.ok),
      finalizeCode: finalized.data.code || null,
      responseId,
      immediate,
      delayed,
      afterSigned,
      restStates,
    }));
  }
};
