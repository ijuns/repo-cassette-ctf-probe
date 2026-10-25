module.exports = async function protojsonAliasProbe({context}) {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(item => item.startsWith('Actions.Results:'));
  const [, runBackend, jobBackend] = scope.split(':');
  const service = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const base = [
    `"workflow_run_backend_id":${JSON.stringify(runBackend)}`,
    `"workflow_job_run_backend_id":${JSON.stringify(jobBackend)}`,
  ];
  const safe = JSON.stringify('application/json');
  const nel = JSON.stringify('application/json\u0085');
  const cases = [
    ['snake-safe-camel-nel', `"mime_type":${safe},"mimeType":${nel}`],
    ['camel-nel-snake-safe', `"mimeType":${nel},"mime_type":${safe}`],
    ['snake-nel-camel-safe', `"mime_type":${nel},"mimeType":${safe}`],
    ['camel-safe-snake-nel', `"mimeType":${safe},"mime_type":${nel}`],
    ['camel-only-nel', `"mimeType":${nel}`],
    ['snake-object-safe', `"mime_type":{"value":${safe}}`],
    ['camel-object-nel', `"mimeType":{"value":${nel}}`],
    ['snake-safe-camel-object-nel', `"mime_type":${safe},"mimeType":{"value":${nel}}`],
    ['snake-object-nel-camel-safe', `"mime_type":{"value":${nel}},"mimeType":${safe}`],
    ['snake-type-safe', `"mime_type":{"@type":"type.googleapis.com/google.protobuf.StringValue","value":${safe}}`],
    ['snake-array-safe', `"mime_type":[${safe}]`],
    ['camel-safe-only', `"mimeType":${safe}`],
  ];
  const bytes = Buffer.from('{"probe":"protojson-alias"}');

  async function twirp(method, json) {
    const response = await fetch(service + method, {
      method: 'POST',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: json,
    });
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }

  for (const [label, fragment] of cases) {
    const name = `protojson-alias-${context.runId}-${label}`;
    const createJson = `{${[...base, `"name":${JSON.stringify(name)}`, '"version":7', fragment].join(',')}}`;
    const created = await twirp('CreateArtifact', createJson);
    const uploadUrl = created.data.signed_upload_url || created.data.signedUploadUrl;
    if (!created.data.ok || !uploadUrl) {
      console.log('ALIAS', JSON.stringify({label, create: created.status, accepted: false}));
      continue;
    }
    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': 'application/json\u0085',
        'content-length': String(bytes.length),
      },
      body: bytes,
    });
    if (!uploaded.ok) {
      console.log('ALIAS', JSON.stringify({label, create: created.status, accepted: true, upload: uploaded.status}));
      continue;
    }
    const finalized = await twirp('FinalizeArtifact', `{${[...base, `"name":${JSON.stringify(name)}`, `"size":${JSON.stringify(String(bytes.length))}`].join(',')}}`);
    const id = String(finalized.data.artifact_id || finalized.data.artifactId || '');
    let restStatus = null;
    let rsct = null;
    if (/^\d+$/.test(id)) {
      const response = await fetch(
        `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`,
        {redirect: 'manual', headers: {authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github.v3+json'}},
      );
      restStatus = response.status;
      const location = response.headers.get('location');
      rsct = location ? new URL(location).searchParams.get('rsct') : null;
    }
    console.log('ALIAS', JSON.stringify({label, create: created.status, upload: uploaded.status,
      finalize: finalized.status, restStatus, rsct}));
  }
};
