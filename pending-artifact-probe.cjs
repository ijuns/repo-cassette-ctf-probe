module.exports = async function pendingArtifactProbe({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsOrigin = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(item => item.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const name = `pending-probe-${context.runId}`;
  const service = `${resultsOrigin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const body = Buffer.from('{"probe":"pending-artifact","owner":{"avatar_url":"https://example.com/"}}');

  async function twirp(method, payload) {
    const response = await fetch(service + method, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    return {status: response.status, data};
  }
  async function list(phase, filterByName = false) {
    const result = await twirp('ListArtifacts', filterByName ? {...ids, name_filter: name} : ids);
    const artifacts = result.data.artifacts || [];
    const matches = artifacts.filter(item => item.name === name);
    const numericIds = matches.map(item => String(item.database_id || item.databaseId || '')).filter(Boolean);
    console.log('LIST', JSON.stringify({phase, filterByName, status: result.status, total: artifacts.length, ids: numericIds}));
    return numericIds;
  }
  async function rest(phase, artifactId) {
    const url = `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${artifactId}/zip`;
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
    });
    const location = response.headers.get('location');
    const rsct = location ? new URL(location).searchParams.get('rsct') : null;
    console.log('REST', JSON.stringify({phase, artifactId, status: response.status, rsct}));
    return {status: response.status, rsct};
  }

  const created = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
  const uploadUrl = created.data.signed_upload_url || created.data.signedUploadUrl;
  console.log('CREATE', JSON.stringify({status: created.status, ok: Boolean(created.data.ok), uploadUrl: Boolean(uploadUrl)}));
  if (!uploadUrl) return;

  const uploaded = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': 'application/json\u0085',
      'Content-Length': String(body.length),
    },
    body,
  });
  console.log('UPLOAD', JSON.stringify({status: uploaded.status}));
  if (!uploaded.ok) return;

  const preIds = await list('before-finalize');
  for (const artifactId of preIds) await rest('before-finalize', artifactId);
  const filteredPreIds = await list('before-finalize-filtered', true);
  for (const artifactId of filteredPreIds) if (!preIds.includes(artifactId)) await rest('before-finalize-filtered', artifactId);

  const signed = await twirp('GetSignedArtifactURL', {...ids, name});
  const signedUrl = signed.data.signed_url || signed.data.signedUrl;
  console.log('SIGNED', JSON.stringify({status: signed.status, rsct: signedUrl ? new URL(signedUrl).searchParams.get('rsct') : null}));

  const finalized = await twirp('FinalizeArtifact', {...ids, name, size: String(body.length)});
  const finalId = String(finalized.data.artifact_id || finalized.data.artifactId || '');
  console.log('FINALIZE', JSON.stringify({status: finalized.status, ok: Boolean(finalized.data.ok), id: finalId}));
  const postIds = await list('after-finalize');
  await list('after-finalize-filtered', true);
  if (finalId) await rest('after-finalize', finalId);
  for (const artifactId of postIds) if (artifactId !== finalId) await rest('after-finalize-other', artifactId);
};
