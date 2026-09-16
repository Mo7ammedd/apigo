export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export type Document = Record<string, unknown>;

export interface SchemaObject {
  [key: string]: unknown;
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: Schema;
  enum?: unknown[];
  const?: unknown;
  example?: unknown;
  examples?: unknown[];
  default?: unknown;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
}
export type Schema = SchemaObject | boolean;

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema: Schema;
  example?: unknown;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  collectionFormat?: string;
  contentType?: string;
}

export interface MediaType {
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, unknown>;
  encoding?: Record<string, unknown>;
}

export interface RequestBody {
  required: boolean;
  description?: string;
  content: Record<string, MediaType>;
}

export type SecurityRequirement = Record<string, string[]>;
export interface SecurityScheme {
  type: string;
  scheme?: string;
  name?: string;
  in?: 'header' | 'query' | 'cookie';
  description?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
}

export interface Operation {
  key: string;
  aliases: string[];
  operationId?: string;
  tags: string[];
  group: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  parameters: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, unknown>;
  security: SecurityRequirement[];
  servers: string[];
  deprecated: boolean;
  url?: string;
  preset?: RequestOptions;
}

export interface ApiDefinition {
  kind: 'openapi' | 'postman';
  title: string;
  version: string;
  specVersion: string;
  source: string;
  baseUrl?: string;
  document: Document;
  operations: Operation[];
  schemas: Record<string, Schema>;
  securitySchemes: Record<string, SecurityScheme>;
}

export interface ApiRecord {
  id: string;
  name: string;
  definition: ApiDefinition;
  previous?: ApiDefinition;
  lastDiff?: ApiDiff;
  createdAt: string;
  updatedAt: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  values?: Record<string, unknown>;
  body?: unknown;
  contentType?: string;
  baseUrl?: string;
  timeout?: number;
  verify?: boolean;
  followRedirects?: boolean;
  maxResponseBytes?: number;
  example?: boolean;
  noAuth?: boolean;
  useAuth?: boolean;
  noHistory?: boolean;
}

export interface RequestRecipe {
  kind: 'operation' | 'http';
  apiId?: string;
  operation?: string;
  method?: HttpMethod;
  url?: string;
  options: RequestOptions;
}

export interface PreparedRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeout: number;
  verify: boolean;
  followRedirects: boolean;
  maxResponseBytes: number;
  sensitiveHeaders: string[];
  sensitiveQuery: string[];
  sensitiveCookies: string[];
}

export interface Timings {
  totalMs: number;
  headersMs: number;
  downloadMs: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
}

export interface HttpResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  timings: Timings;
  redirects: number;
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  recipe: RequestRecipe;
  request: Pick<PreparedRequest, 'method' | 'url' | 'headers' | 'body'>;
  response?: HttpResponse;
  error?: { code: string; message: string };
  responseTruncated?: boolean;
}

export interface SavedRequest {
  name: string;
  recipe: RequestRecipe;
  createdAt: string;
}

export interface DiffChange { message: string; breaking: boolean }
export interface ChangedItem { name: string; changes: DiffChange[] }
export interface ApiDiff {
  addedOperations: string[];
  removedOperations: string[];
  changedOperations: ChangedItem[];
  addedSchemas: string[];
  removedSchemas: string[];
  changedSchemas: ChangedItem[];
  changes: DiffChange[];
  breaking: boolean;
}

export interface PromptAdapter {
  parameter(parameter: Parameter, schema: SchemaObject): Promise<unknown>;
  body(schema: Schema, document: Document, example?: unknown): Promise<unknown>;
  confirmRequest(request: PreparedRequest): Promise<boolean>;
}
