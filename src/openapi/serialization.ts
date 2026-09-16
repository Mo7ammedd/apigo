import { ApigoError } from '../core/errors.js';
import type { Parameter } from '../core/types.js';
import { isRecord } from '../utils/objects.js';

const encode = (value: unknown): string => encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function pathValue(parameter: Parameter, value: unknown): string {
  if (value === '.' || value === '..') throw new ApigoError('INVALID_PARAMETER', `Path parameter ${parameter.name} cannot be a dot-only segment.`);
  const style = parameter.style ?? 'simple';
  if (!['simple', 'label', 'matrix'].includes(style)) throw new ApigoError('UNSUPPORTED_PARAMETER', 'Unsupported path parameter serialization style.');
  const explode = parameter.explode ?? false;
  const name = encode(parameter.name);
  let content: string;
  if (Array.isArray(value)) {
    const separator = style === 'label' && explode ? '.' : style === 'matrix' && explode ? `;${name}=` : ',';
    content = value.map(encode).join(separator);
  } else if (isRecord(value)) {
    const separator = style === 'label' && explode ? '.' : style === 'matrix' && explode ? ';' : ',';
    content = Object.entries(value).map(([key, val]) => `${encode(key)}${explode ? '=' : ','}${encode(val)}`).join(separator);
  } else content = encode(value);
  if (style === 'label') return `.${content}`;
  if (style === 'matrix') return isRecord(value) && explode ? `;${content}` : `;${name}=${content}`;
  return content;
}

export function queryValues(parameter: Parameter, value: unknown): [string, string][] {
  const name = parameter.name;
  if (parameter.contentType) return [[name, JSON.stringify(value)]];
  const style = parameter.style ?? 'form';
  const explode = parameter.explode ?? (style === 'form');
  if (parameter.collectionFormat && Array.isArray(value)) {
    const separators: Record<string, string> = { csv: ',', ssv: ' ', tsv: '\t', pipes: '|' };
    return parameter.collectionFormat === 'multi' ? value.map(item => [name, String(item)]) : [[name, value.map(String).join(separators[parameter.collectionFormat] ?? ',')]];
  }
  if (isRecord(value)) {
    if (Object.values(value).some(item => item !== null && typeof item === 'object')) throw new ApigoError('UNSUPPORTED_PARAMETER', `Nested query objects need a content-based parameter: ${name}.`);
    if (style === 'deepObject') return Object.entries(value).map(([key, val]) => [`${name}[${key}]`, String(val)]);
    if (style !== 'form') throw new ApigoError('UNSUPPORTED_PARAMETER', `Unsupported object query style: ${style}.`);
    return explode ? Object.entries(value).map(([key, val]) => [key, String(val)]) : [[name, Object.entries(value).flatMap(([key, val]) => [key, String(val)]).join(',')]];
  }
  if (Array.isArray(value)) {
    if (style === 'spaceDelimited') return [[name, value.map(String).join(' ')]];
    if (style === 'pipeDelimited') return [[name, value.map(String).join('|')]];
    if (style !== 'form') throw new ApigoError('UNSUPPORTED_PARAMETER', `Unsupported array query style: ${style}.`);
    return explode ? value.map(item => [name, String(item)]) : [[name, value.map(String).join(',')]];
  }
  return [[name, String(value)]];
}

export function headerValue(parameter: Parameter, value: unknown): string {
  if (parameter.contentType) return JSON.stringify(value);
  if (Array.isArray(value)) return value.map(String).join(',');
  if (isRecord(value)) return Object.entries(value).map(([key, val]) => `${key}${parameter.explode ? '=' : ','}${String(val)}`).join(',');
  return String(value);
}
