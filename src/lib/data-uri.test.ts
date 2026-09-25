/// <reference types="bun-types" />
/**
 * data-URI JSON decoder tests.
 *
 * `node:zlib` appears here only as the gzip *encoder* for fixtures — this file
 * is never bundled and never enters the Edge instrumentation graph.
 *
 * Run: bun test src/lib/data-uri.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { decodeDataUriJson } from './data-uri';

const REG = { name: 'Agent', description: 'd' };
const json = JSON.stringify(REG);
const gzipped = (s: string) => gzipSync(Buffer.from(s));

describe('decodeDataUriJson', () => {
  test('base64 body', () => {
    const uri = 'data:application/json;base64,' + Buffer.from(json).toString('base64');
    expect(decodeDataUriJson(uri)).toEqual(REG);
  });

  test('percent-encoded body', () => {
    expect(decodeDataUriJson('data:application/json,' + encodeURIComponent(json))).toEqual(REG);
  });

  test('gzip + base64 body', () => {
    const uri = 'data:application/json;enc=gzip;base64,' + gzipped(json).toString('base64');
    expect(decodeDataUriJson(uri)).toEqual(REG);
  });

  test('missing comma separator throws', () => {
    expect(() => decodeDataUriJson('data:application/json;base64')).toThrow();
  });

  test('non-JSON body throws', () => {
    expect(() => decodeDataUriJson('data:text/plain,' + encodeURIComponent('hello'))).toThrow();
  });

  // A declared enc=gzip over bytes that are not gzip must fail loudly, not
  // silently return the raw body — the callers turn the throw into `invalid`.
  test('enc=gzip over a non-gzip body throws', () => {
    const uri = 'data:application/json;enc=gzip;base64,' + Buffer.from(json).toString('base64');
    expect(() => decodeDataUriJson(uri)).toThrow();
  });
});
