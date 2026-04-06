import { get_encoding, type Tiktoken } from "@dqbd/tiktoken";
import type { TokenizerId } from "./types";

const cache = new Map<TokenizerId, Tiktoken>();

export function getTokenizer(id: TokenizerId): Tiktoken {
  let enc = cache.get(id);
  if (!enc) {
    enc = get_encoding(id);
    cache.set(id, enc);
  }
  return enc;
}

export function countTokens(text: string, tokenizerId: TokenizerId): number {
  if (!text) return 0;
  const enc = getTokenizer(tokenizerId);
  return enc.encode(text).length;
}

export function freeAllEncodings(): void {
  for (const enc of cache.values()) {
    enc.free();
  }
  cache.clear();
}
