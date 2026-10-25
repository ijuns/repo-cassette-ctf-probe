module.exports = async function scanNames({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const base = new URL(resultsUrl).origin;
  const service = 'github.actions.results.api.v1.ArtifactService';
  const names = [
    ['u010a-low-lf', 'probe\u010ax.json'],
    ['u010d-low-cr', 'probe\u010dx.json'],
    ['u0185-low-nel', 'probe\u0185x.json'],
    ['u0285-low-nel', 'probe\u0285x.json'],
    ['u1085-low-nel', 'probe\u1085x.json'],
  ];
  async function twirp(method, body) {
    const response = await fetch(`${base}/twirp/${service}/${method}`, {
      method: 'POST', headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    return [response.status, await response.json()];
  }
  for (const [label, name] of names) {
    const [status, created] = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
    if (status !== 200 || !created.ok) {
      console.log(`${label}: Create HTTP ${status}; ${created.msg || ''}`);
      continue;
    }
    const signedUploadUrl = created.signed_upload_url || created.signedUploadUrl;
    const body = Buffer.from('{"probe":"unicode-name"}');
    const put = await fetch(signedUploadUrl, {
      method: 'PUT',
      headers: {'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05', 'x-ms-blob-type': 'BlockBlob'},
      body,
    });
    if (!put.ok) { console.log(`${label}: PUT HTTP ${put.status}`); continue; }
    const [finalStatus, finalized] = await twirp('FinalizeArtifact', {...ids, name, size: String(body.length)});
    if (finalStatus !== 200 || !finalized.ok) {
      console.log(`${label}: Finalize HTTP ${finalStatus}; ${finalized.msg || ''}`);
      continue;
    }
    const id = String(finalized.artifact_id || finalized.artifactId);
    const url = `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`;
    const download = await fetch(url, {redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'}});
    const location = download.headers.get('location');
    let rscd = '', rsct = '', rawStatus = '', rawType = '';
    if (location) {
      const parsed = new URL(location);
      rscd = parsed.searchParams.get('rscd');
      rsct = parsed.searchParams.get('rsct');
      const raw = await fetch(location);
      rawStatus = raw.status;
      rawType = raw.headers.get('content-type');
    }
    console.log(`${label}: id=${id}; github=${download.status}; rscd=${JSON.stringify(rscd)}; rsct=${JSON.stringify(rsct)}; raw=${rawStatus}; Content-Type=${JSON.stringify(rawType)}`);
  }
};
