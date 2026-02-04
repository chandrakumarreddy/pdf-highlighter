/**
 * Text similarity utilities using Jaccard Similarity with N-gram tokenization
 */

export interface SimilarityMatch {
  text: string;
  score: number;
  startIndex: number;
  endIndex: number;
}

/**
 * Tokenize text into n-grams (contiguous sequences of n words)
 * @param text - The text to tokenize
 * @param minGram - Minimum n-gram size (default 2)
 * @param maxGram - Maximum n-gram size (default 3)
 * @returns Array of n-gram tokens
 */
export function tokenizeIntoNgrams(
  text: string,
  minGram: number = 2,
  maxGram: number = 3,
): string[] {
  // Normalize text: lowercase, remove extra whitespace, trim
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");

  // Split into words
  const words = normalized.split(" ").filter((word) => word.length > 0);

  if (words.length === 0) {
    return [];
  }

  const tokens: string[] = [];

  // Generate n-grams of sizes minGram to maxGram
  for (let gramSize = minGram; gramSize <= maxGram; gramSize++) {
    for (let i = 0; i <= words.length - gramSize; i++) {
      const gram = words.slice(i, i + gramSize).join(" ");
      tokens.push(gram);
    }
  }

  return tokens;
}

/**
 * Calculate Jaccard similarity between two token sets
 * Jaccard = |intersection| / |union|
 * @param tokens1 - First set of tokens
 * @param tokens2 - Second set of tokens
 * @returns Similarity score between 0 and 1
 */
export function calculateJaccardSimilarity(
  tokens1: string[],
  tokens2: string[],
): number {
  // Convert to Sets for efficient operations
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);

  // Calculate intersection size
  let intersectionSize = 0;
  for (const token of set1) {
    if (set2.has(token)) {
      intersectionSize++;
    }
  }

  // Calculate union size
  const unionSize = set1.size + set2.size - intersectionSize;

  // Avoid division by zero
  if (unionSize === 0) {
    return 0;
  }

  return intersectionSize / unionSize;
}

/**
 * Find similar text passages within a corpus using sliding window
 * @param searchText - The text to search for
 * @param corpus - The larger text to search within
 * @param threshold - Minimum similarity score (0-1, default 0.8)
 * @returns Array of similar matches
 */
export function findSimilarText(
  searchText: string,
  corpus: string,
  threshold: number = 0.8,
): SimilarityMatch[] {
  // Minimum text length to avoid false positives
  const MIN_TEXT_LENGTH = 15;

  const normalizedSearchText = searchText.toLowerCase().trim().replace(/\s+/g, " ");
  const normalizedCorpus = corpus.toLowerCase().trim().replace(/\s+/g, " ");

  // Validate inputs
  if (normalizedSearchText.length < MIN_TEXT_LENGTH) {
    return [];
  }

  const searchTokens = tokenizeIntoNgrams(normalizedSearchText);
  if (searchTokens.length === 0) {
    return [];
  }

  const searchWords = normalizedSearchText.split(" ");
  const searchWordCount = searchWords.length;
  const corpusWords = normalizedCorpus.split(" ");

  // Allow 20% variance in length (±20% of search text length)
  const minLength = Math.max(1, Math.floor(searchWordCount * 0.8));
  const maxLength = Math.ceil(searchWordCount * 1.2);

  const matches: SimilarityMatch[] = [];

  // Sliding window search
  for (let i = 0; i <= corpusWords.length - minLength; i++) {
    // Try different window sizes
    for (let windowSize = minLength; windowSize <= maxLength; windowSize++) {
      if (i + windowSize > corpusWords.length) {
        break;
      }

      const windowText = corpusWords.slice(i, i + windowSize).join(" ");
      const windowTokens = tokenizeIntoNgrams(windowText);

      const score = calculateJaccardSimilarity(searchTokens, windowTokens);

      if (score >= threshold) {
        matches.push({
          text: windowText,
          score,
          startIndex: i,
          endIndex: i + windowSize,
        });
      }
    }
  }

  // Deduplicate overlapping matches (keep highest scoring)
  const deduplicatedMatches = deduplicateOverlappingMatches(matches);

  // Sort by score descending
  return deduplicatedMatches.sort((a, b) => b.score - a.score);
}

/**
 * Remove overlapping matches, keeping the highest scoring ones
 */
function deduplicateOverlappingMatches(matches: SimilarityMatch[]): SimilarityMatch[] {
  if (matches.length === 0) {
    return [];
  }

  // Sort by score descending first
  const sorted = [...matches].sort((a, b) => b.score - a.score);

  const nonOverlapping: SimilarityMatch[] = [];

  for (const match of sorted) {
    let overlaps = false;
    for (const existing of nonOverlapping) {
      if (rangesOverlap(match.startIndex, match.endIndex, existing.startIndex, existing.endIndex)) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      nonOverlapping.push(match);
    }
  }

  return nonOverlapping;
}

/**
 * Check if two ranges overlap
 */
function rangesOverlap(
  start1: number,
  end1: number,
  start2: number,
  end2: number,
): boolean {
  // Allow 5 word tolerance for minor overlaps
  const tolerance = 5;
  return !(end1 + tolerance < start2 || start1 - tolerance > end2);
}
