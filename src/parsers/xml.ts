import { XMLParser } from 'fast-xml-parser';
import { stripBom } from '../util';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  processEntities: true,
  htmlEntities: true,
  allowBooleanAttributes: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type XNode = any;

export function parseXml(text: string): XNode {
  return parser.parse(stripBom(text));
}

/** Text of an element that may be a string, an object with #text, or missing. */
export function textOf(n: XNode): string {
  if (n === undefined || n === null) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(textOf).join('\n');
  if (typeof n === 'object') return typeof n['#text'] === 'string' ? n['#text'] : '';
  return String(n);
}
