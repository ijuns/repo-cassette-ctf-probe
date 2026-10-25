module.exports = async function emptyFinalizeProbe({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsOrigin = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(item => item.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const name = `empty-finalize-${context.runId}.json`;
  const service = `${resultsOrigin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const body = Buffer.from('{"probe":"empty-finalize"}');

  async function twirp(method, payload) {
    const response = await fetch(service + method, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    return {status: response.status, data};
  }
  async function signed(phase) {
    const result = await twirp('GetSignedArtifactURL', {...ids, name});
    const url = result.data.signed_url || result.data.signedUrl;
    console.log('EMPTY-SIGNED', JSON.stringify({phase, status: result.status,
      rsct: url ? new URL(url).searchParams.get('rsct') : null}));
  }
  async function rest(phase, artifactId) {
    const response = await fetch(
      `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${artifactId}/zip`,
      {redirect: 'manual', headers: {
        'Authorization': `Bearer ${process.env.GH_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      }},
    );
    const location = response.headers.get('location');
    const rsct = location ? new URL(location).searchParams.get('rsct') : null;
    let blobStatus = null;
    let blobType = null;
    if (location) {
      const blob = await fetch(location, {headers: {'Range': 'bytes=0-0'}});
      blobStatus = blob.status;
      blobType = blob.headers.get('content-type');
      await blob.arrayBuffer();
    }
    console.log('EMPTY-REST', JSON.stringify({phase, artifactId, status: response.status,
      rsct, blobStatus, blobType}));
  }

  const created = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
  const uploadUrl = created.data.signed_upload_url || created.data.signedUploadUrl;
  const uploadSegments = uploadUrl ? new URL(uploadUrl).pathname.split('/').filter(Boolean) : [];
  console.log('EMPTY-CREATE', JSON.stringify({status: created.status, ok: !!created.data.ok,
    hasUploadUrl: !!uploadUrl, responseKeys: Object.keys(created.data).sort(),
    uploadPathSegmentLengths: uploadSegments.map(segment => segment.length),
    decimalSegments: uploadSegments.map(segment => /^[0-9]+$/.test(segment))}));
  if (!uploadUrl) return;
  await signed('before-finalize-no-blob');

  const finalized = await twirp('FinalizeArtifact', {...ids, name, size: String(body.length)});
  const artifactId = String(finalized.data.artifact_id || finalized.data.artifactId || '');
  console.log('EMPTY-FINALIZE', JSON.stringify({status: finalized.status, ok: !!finalized.data.ok, artifactId}));
  if (!artifactId) return;
  await signed('after-finalize-no-blob');
  await rest('finalized-no-blob', artifactId);

  const uploaded = await fetch(uploadUrl, {method: 'PUT', headers: {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': 'application/json\u0085',
    'Content-Length': String(body.length),
  }, body});
  console.log('EMPTY-UPLOAD', JSON.stringify({status: uploaded.status}));
  if (!uploaded.ok) return;
  await signed('after-late-upload');
  await rest('after-late-upload', artifactId);
};
