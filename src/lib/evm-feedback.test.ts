/// <reference types="bun-types" />
/**
 * evm-feedback pure helpers — the calldata encoder is the highest-risk piece:
 * a wrong ABI/arg order silently writes a garbage feedback record on-chain.
 * Roundtrip every encode through viem's decoder to prove the args land exactly.
 */
import { describe, expect, test } from 'bun:test';
import { decodeFunctionData, keccak256 } from 'viem';
import {
  encodeGiveFeedback,
  starsToValue,
  feedbackChainConfig,
  GIVE_FEEDBACK_ABI,
  REVIEW_TAG1,
  REVIEW_SCHEME_VERSION,
} from './evm-feedback';
import { decodeFeedbackCommentDataUri, parseFeedbackComment } from './feedback-comment';

const ZERO_HASH = `0x${'0'.repeat(64)}` as `0x${string}`;

describe('starsToValue', () => {
  test('maps 1-5 stars onto the 0-100 scale', () => {
    expect(starsToValue(1)).toBe(20);
    expect(starsToValue(3)).toBe(60);
    expect(starsToValue(5)).toBe(100);
  });
  test('clamps out-of-range input', () => {
    expect(starsToValue(0)).toBe(20);
    expect(starsToValue(9)).toBe(100);
  });
});

describe('encodeGiveFeedback', () => {
  test('calldata decodes back to the exact giveFeedback args (defaults)', () => {
    const data = encodeGiveFeedback({ agentId: 9225, value: 100 });
    const { functionName, args } = decodeFunctionData({ abi: GIVE_FEEDBACK_ABI, data });
    expect(functionName).toBe('giveFeedback');
    expect(args[0]).toBe(9225n); // agentId
    expect(args[1]).toBe(100n); // value
    expect(args[2]).toBe(0); // valueDecimals
    expect(args[3]).toBe(REVIEW_TAG1); // tag1
    expect(args[4]).toBe(REVIEW_SCHEME_VERSION); // tag2
    expect(args[5]).toBe(''); // endpoint
    expect(args[6]).toBe(''); // feedbackURI
    expect(args[7]).toBe(ZERO_HASH); // feedbackHash
  });

  test('honors custom tags', () => {
    const data = encodeGiveFeedback({ agentId: 1, value: 60, tag1: 'partner_audit', tag2: 'v2' });
    const { args } = decodeFunctionData({ abi: GIVE_FEEDBACK_ABI, data });
    expect(args[3]).toBe('partner_audit');
    expect(args[4]).toBe('v2');
  });

  test('accepts bigint agentId', () => {
    const data = encodeGiveFeedback({ agentId: 72077n, value: 80 });
    const { args } = decodeFunctionData({ abi: GIVE_FEEDBACK_ABI, data });
    expect(args[0]).toBe(72077n);
  });

  test('a comment inlines a data: URI whose keccak hash lands in feedbackHash', () => {
    const data = encodeGiveFeedback({ agentId: 1, value: 100, stars: 5, comment: 'fast and reliable' });
    const { args } = decodeFunctionData({ abi: GIVE_FEEDBACK_ABI, data });
    const uri = args[6] as string;
    const hash = args[7] as `0x${string}`;

    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    expect(hash).not.toBe(ZERO_HASH);

    // The hash MUST be keccak256 of the exact bytes the URI encodes — that's the
    // integrity contract the reader verifies.
    const bytes = decodeFeedbackCommentDataUri(uri)!;
    expect(keccak256(bytes)).toBe(hash);
    expect(parseFeedbackComment(bytes)).toEqual({
      schema: 'agentkarma/feedback-comment/v1',
      value: 100,
      stars: 5,
      comment: 'fast and reliable',
    });
  });

  test('an empty / whitespace comment keeps the empty URI + zero hash', () => {
    for (const comment of [undefined, '', '   ']) {
      const data = encodeGiveFeedback({ agentId: 1, value: 60, comment });
      const { args } = decodeFunctionData({ abi: GIVE_FEEDBACK_ABI, data });
      expect(args[6]).toBe('');
      expect(args[7]).toBe(ZERO_HASH);
    }
  });
});

describe('feedbackChainConfig', () => {
  test('celo: chainId 0xa4ec, mainnet registry, celoscan tx url', () => {
    const c = feedbackChainConfig('celo');
    expect(c.chainIdHex).toBe('0xa4ec');
    expect(c.registry).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
    expect(c.explorerTxUrl('0xabc')).toBe('https://celoscan.io/tx/0xabc');
  });

  test('arc: chainId 0x4cef52, testnet registry, add-chain params present', () => {
    const c = feedbackChainConfig('arc');
    expect(c.chainIdHex).toBe('0x4cef52');
    expect(c.registry).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
    expect(c.addChainParams.chainId).toBe('0x4cef52');
    expect(Array.isArray(c.addChainParams.rpcUrls)).toBe(true);
  });
});
