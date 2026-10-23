// Public, unauthenticated probes only. No cookies, API keys, OAuth client
// registration, account changes, translation requests or private endpoints.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function probe(name, url, init = {}, fields = []) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', ...init.headers },
    });
    const content = await response.text();
    let parsed;
    try { parsed = JSON.parse(content); } catch { /* Public error page, record status only. */ }
    const selected = {};
    for (const field of fields) if (parsed?.[field] !== undefined) selected[field] = parsed[field];
    return {
      name, url, status: response.status, milliseconds: Date.now() - started,
      contentType: response.headers.get('content-type'),
      wwwAuthenticate: response.headers.get('www-authenticate'),
      ...(Object.keys(selected).length ? { metadata: selected } : {}),
      ...(parsed?.error && typeof parsed.error === 'string' ? { errorCode: parsed.error } : {}),
      ...(parsed?.error?.code ? { errorCode: parsed.error.code } : {}),
    };
  } catch (error) {
    return { name, url, status: null, errorName: error.name,
      causeCode: error.cause?.code ?? null, milliseconds: Date.now() - started };
  }
}
const records = await Promise.all([
  probe('deepseek-rest-no-auth', 'https://api.deepseek.com/models'),
  probe('deepl-rest-no-auth', 'https://api-free.deepl.com/v2/usage'),
  probe('deepl-mcp-anonymous-initialize', 'https://mcp.deepl.com/v1/mcp', {
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'near-translate-public-feasibility-probe', version: '0.0.1' },
    } }),
  }),
]);
const challenge = records[2].wwwAuthenticate || '';
const resourceMetadata = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
function allowedMetadataUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'mcp.deepl.com'
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
if (resourceMetadata && allowedMetadataUrl(resourceMetadata)) {
  const resource = await probe('deepl-protected-resource-metadata', resourceMetadata, {},
    ['resource', 'authorization_servers', 'scopes_supported', 'bearer_methods_supported']);
  records.push(resource);
  for (const issuer of (resource.metadata?.authorization_servers ?? []).slice(0, 2)) {
    if (!allowedMetadataUrl(issuer)) continue;
    const base = new URL(issuer);
    const metadataUrl = `${base.origin}/.well-known/oauth-authorization-server${base.pathname === '/' ? '' : base.pathname}`;
    records.push(await probe('deepl-authorization-server-metadata', metadataUrl, {}, [
      'issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint',
      'response_types_supported', 'grant_types_supported', 'code_challenge_methods_supported',
      'token_endpoint_auth_methods_supported', 'client_id_metadata_document_supported', 'scopes_supported',
    ]));
  }
}
const result = {
  generatedAt: new Date().toISOString(), scope: 'public-authentication-and-discovery-only',
  authenticated: false, translationExecuted: false, oauthClientRegistered: false,
  userCookiesReadOrSent: false, apiKeyUsed: false, records,
};
await mkdir(resolve(workspace, 'docs/evidence'), { recursive: true });
await writeFile(resolve(workspace, 'docs/evidence/public-translation-auth-probe-2026-10-21.json'),
  JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
