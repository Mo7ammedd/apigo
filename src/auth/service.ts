import { ApigoError } from '../core/errors.js';
import type { ApiRecord, Operation, PreparedRequest, SecurityScheme } from '../core/types.js';
import type { Variables } from '../environments/interpolation.js';
import { interpolate } from '../environments/interpolation.js';
import type { Store } from '../storage/database.js';
import type { Redactor } from '../utils/security.js';
import { normalizeHeaders } from '../core/request.js';

export interface Secret { value?: string; env?: string }
export interface Credential {
  type: 'bearer' | 'basic' | 'apikey' | 'oauth2';
  token?: Secret;
  username?: Secret;
  password?: Secret;
  name?: string;
  in?: 'header' | 'query' | 'cookie';
  scopes?: string[];
}

function compatible(credential: Credential, scheme: SecurityScheme): boolean {
  if (scheme.type === 'apiKey') return credential.type === 'apikey' || scheme.name?.toLowerCase() === 'authorization' && ['bearer', 'oauth2', 'basic'].includes(credential.type);
  if (scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'basic') return credential.type === 'basic';
  if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect' || scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer') return ['bearer', 'oauth2'].includes(credential.type);
  return false;
}

export class AuthService {
  constructor(private readonly store: Store, private readonly redactor: Redactor) {}
  set(scope: string, scheme: string, credential: Credential): void {
    if (credential.type === 'basic' && (!credential.username || !credential.password)) throw new ApigoError('AUTH_CONFIG', 'Basic authentication requires a username and password.');
    if (credential.type !== 'basic' && !credential.token) throw new ApigoError('AUTH_CONFIG', 'A token or API key is required.');
    if (credential.type === 'apikey' && credential.in && !['header', 'query', 'cookie'].includes(credential.in)) throw new ApigoError('AUTH_CONFIG', 'API key location must be header, query, or cookie.');
    for (const secret of [credential.token, credential.username, credential.password]) {
      if (!secret) continue;
      if ((secret.value === undefined) === (secret.env === undefined)) throw new ApigoError('AUTH_CONFIG', 'Configure either a secret value or an environment reference.');
      if (secret.env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.env)) throw new ApigoError('AUTH_CONFIG', 'Invalid process environment variable name.');
      this.redactor.add(secret.value);
    }
    this.store.putCredential(scope, scheme, credential);
  }
  list(scope: string): { scheme: string; credential: Credential }[] {
    return this.store.credentialSchemes(scope).map(scheme => {
      const credential = this.store.credential<Credential>(scope, scheme)!;
      for (const secret of [credential.token, credential.username, credential.password]) this.redactor.add(secret?.value);
      return { scheme, credential };
    });
  }
  remove(scope: string, scheme?: string): void { this.store.removeCredential(scope, scheme); }

  private secret(input: Secret | undefined, variables: Variables): string {
    if (!input) throw new ApigoError('AUTH_CONFIG', 'A configured credential is incomplete.');
    const value = input.env ? process.env[input.env] ?? variables[input.env] : interpolate(input.value ?? '', variables);
    if (!value) throw new ApigoError('AUTH_MISSING', input.env ? `Credential environment variable ${input.env} is not set.` : 'The configured credential is empty.');
    this.redactor.add(value);
    return value;
  }

  private profile(scope: string, name: string, scheme: SecurityScheme): Credential | undefined {
    const candidates = [this.store.credential<Credential>(scope, name), this.store.credential<Credential>(scope, 'default'),
      this.store.credential<Credential>('*', name), this.store.credential<Credential>('*', 'default')];
    return candidates.find(credential => credential && compatible(credential, scheme));
  }

  private attach(request: PreparedRequest, credential: Credential, scheme: SecurityScheme, variables: Variables): void {
    if (credential.type === 'basic') {
      const username = this.secret(credential.username, variables);
      if (username.includes(':')) throw new ApigoError('AUTH_CONFIG', 'Basic authentication usernames cannot contain a colon.');
      const value = Buffer.from(`${username}:${this.secret(credential.password, variables)}`).toString('base64');
      this.redactor.add(value);
      request.headers.authorization ??= `Basic ${value}`;
      request.sensitiveHeaders.push('authorization');
      return;
    }
    const token = this.secret(credential.token, variables);
    if (credential.type !== 'apikey') {
      request.headers.authorization ??= `Bearer ${token}`;
      request.sensitiveHeaders.push('authorization');
      return;
    }
    const name = scheme.name ?? credential.name;
    const location = scheme.in ?? credential.in ?? 'header';
    if (!name) throw new ApigoError('AUTH_CONFIG', 'Configure the API key name with --name.');
    this.redactor.addName(name);
    if (location === 'query') {
      const url = new URL(request.url);
      if (!url.searchParams.has(name)) url.searchParams.set(name, token);
      request.url = url.toString(); request.sensitiveQuery.push(name);
    } else if (location === 'cookie') {
      request.headers.cookie = [request.headers.cookie, `${encodeURIComponent(name)}=${encodeURIComponent(token)}`].filter(Boolean).join('; ');
      request.sensitiveCookies.push(name);
    } else { request.headers[name.toLowerCase()] ??= token; request.sensitiveHeaders.push(name.toLowerCase()); }
  }

  apply(request: PreparedRequest, api: ApiRecord | undefined, operation: Operation | undefined, variables: Variables, noAuth = false, directAuth = false): void {
    if (noAuth) return;
    if (!api || !operation) {
      if (!directAuth) return;
      const profile = this.store.credential<Credential>('*', 'default');
      if (!profile) throw new ApigoError('AUTH_MISSING', 'No global authentication is configured.', 2, 'Use apigo auth set <type> --global.');
      this.attach(request, profile, { type: profile.type === 'apikey' ? 'apiKey' : 'http' }, variables);
      request.headers = normalizeHeaders(request.headers);
      return;
    }
    if (!operation.security.length) return;
    for (const requirement of operation.security) {
      const candidate: PreparedRequest = { ...request, headers: { ...request.headers }, sensitiveHeaders: [...request.sensitiveHeaders], sensitiveQuery: [...request.sensitiveQuery], sensitiveCookies: [...request.sensitiveCookies] };
      let satisfied = true;
      for (const name of Object.keys(requirement)) {
        const scheme = api.definition.securitySchemes[name]!;
        const apiKey = scheme.type === 'apiKey';
        const header = apiKey && scheme.in === 'header' ? scheme.name!.toLowerCase() : 'authorization';
        if (apiKey && scheme.name) {
          this.redactor.addName(scheme.name);
          if (scheme.in === 'query') candidate.sensitiveQuery.push(scheme.name);
          if (scheme.in === 'header') candidate.sensitiveHeaders.push(header);
        }
        const existing = apiKey ? scheme.in === 'query' ? new URL(candidate.url).searchParams.has(scheme.name!)
          : scheme.in === 'cookie' ? (candidate.headers.cookie ?? '').split(';').some(cookie => cookie.trim().startsWith(`${scheme.name}=`)) : Boolean(candidate.headers[header])
          : Boolean(candidate.headers.authorization);
        if (existing) continue;
        const profile = this.profile(api.id, name, scheme);
        if (!profile) { satisfied = false; break; }
        try { this.attach(candidate, profile, scheme, variables); }
        catch (error) {
          if (error instanceof ApigoError && error.code === 'AUTH_MISSING') { satisfied = false; break; }
          throw error;
        }
      }
      if (satisfied) { Object.assign(request, candidate); request.headers = normalizeHeaders(request.headers); return; }
    }
    throw new ApigoError('AUTH_REQUIRED', `This operation requires authentication: ${operation.security.map(requirement => Object.keys(requirement).join(' + ')).join(' or ')}.`, 2,
      'Use apigo auth set bearer, basic, or apikey; --scheme selects a named OpenAPI scheme. Use --no-auth to send an unauthenticated request explicitly.');
  }
}
