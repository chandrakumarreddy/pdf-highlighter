/**
 * Similar section finder - orchestrates text extraction and similarity matching
 */

import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { getBoundingRect } from "./get-bounding-rect";
import { viewportToScaled } from "./coordinates";
import { extractAllTextContent, findTextItemsInRange, textItemsToPosition, textItemsToRects, type PageTextContent } from "./pdf-text-extractor";
import { findSimilarText } from "./text-similarity";
import type { LTWHP, ScaledPosition, Viewport } from "../types";

/**
 * Result of a similarity search
 */
export interface SimilarityResult {
  text: string;
  score: number;
  position: ScaledPosition;
}

/**
 * Options for similarity search
 */
export interface SimilaritySearchOptions {
  selectedText: string;
  selectedPosition: ScaledPosition;
  pdfDocument: any;
  viewer: PDFViewer;
  threshold?: number; // default 0.8
  maxResults?: number; // default 20
  maxPages?: number; // default 50, limit pages to search for performance
  onProgress?: (current: number, total: number, found: number) => void;
}

/**
 * Find similar sections across a PDF document
 * @param options - Similarity search options
 * @returns Array of similar sections with positions
 */
export async function findSimilarSections(
  options: SimilaritySearchOptions,
): Promise<SimilarityResult[]> {
  const {
    selectedText,
    selectedPosition,
    pdfDocument,
    viewer,
    threshold = 0.8,
    maxResults = 20,
    maxPages = 50,
    onProgress,
  } = options;

  // Minimum text length to avoid false positives
  const MIN_TEXT_LENGTH = 15;
  const normalizedText = selectedText.toLowerCase().trim().replace(/\s+/g, " ");

  if (normalizedText.length < MIN_TEXT_LENGTH) {
    return [];
  }

  // Limit number of pages to search for performance
  const numPages = Math.min(pdfDocument.numPages, maxPages);

  // Extract text content from all pages
  const pagesMap = await extractAllTextContent(pdfDocument, (current, total) => {
    onProgress?.(current, total, 0);
  });

  const results: SimilarityResult[] = [];
  const selectedPageNumber = selectedPosition.pageNumber;

  // Get the viewport for the original selection page
  const selectedPageView = viewer.getPageView(selectedPageNumber - 1);
  if (!selectedPageView || !selectedPageView.viewport) {
    return [];
  }
  const selectedViewport = selectedPageView.viewport;

  // Search each page for similar content
  let pageNumber = 1;
  for (const [pageNum, pageContent] of pagesMap.entries()) {
    // Find similar text in this page
    const matches = findSimilarText(normalizedText, pageContent.text, threshold);

    for (const match of matches) {
      // Find the text items that correspond to this match
      const textItems = findTextItemsInRange(
        pageContent.items,
        match.startIndex,
        match.endIndex,
      );

      if (textItems.length === 0) {
        continue;
      }

      // Get the viewport for this page
      const pageView = viewer.getPageView(pageNum - 1);
      if (!pageView || !pageView.viewport) {
        continue;
      }
      const viewport = pageView.viewport;

      // Convert text items to viewport rects
      const rects = textItemsToRects(textItems, viewport);

      if (rects.length === 0) {
        continue;
      }

      // Calculate bounding rect
      const boundingRect = getBoundingRect(rects);

      // Convert viewport position to scaled position
      const scaledPosition = viewportToScaled(
        { ...boundingRect, pageNumber: pageNum },
        viewport,
      );

      // Convert all rects to scaled coordinates
      const scaledRects = rects.map((rect) =>
        viewportToScaled({ ...rect, pageNumber: pageNum }, viewport),
      );

      // Check if this is the original selection (by position proximity)
      if (pageNum === selectedPageNumber) {
        if (isOriginalSelection(scaledPosition, selectedPosition, selectedViewport)) {
          continue; // Skip the original selection
        }
      }

      // Check for overlapping results (deduplicate)
      const overlaps = results.some((existing) =>
        positionsOverlap(scaledPosition, existing.position, selectedViewport),
      );

      if (!overlaps) {
        results.push({
          text: match.text,
          score: match.score,
          position: {
            ...scaledPosition,
            rects: scaledRects,
            pageNumber: pageNum,
          },
        });
      }
    }

    onProgress?.(pageNumber, numPages, results.length);

    // Stop if we've found enough results
    if (results.length >= maxResults) {
      break;
    }

    pageNumber++;
  }

  // Sort by score descending and limit results
  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/**
 * Check if a position is the original selection (by position proximity)
 */
function isOriginalSelection(
  candidate: ScaledPosition,
  original: ScaledPosition,
  viewport: Viewport,
): boolean {
  // Use a larger threshold for original selection detection (90% overlap)
  const POSITION_TOLERANCE = 0.9;

  const candidateRect = candidate.boundingRect;
  const originalRect = original.boundingRect;

  // Check if rects are very close (within 10% of viewport dimensions)
  const toleranceX = viewport.width * 0.1;
  const toleranceY = viewport.height * 0.1;

  const xOverlap =
    Math.abs(candidateRect.x1 - originalRect.x1) < toleranceX &&
    Math.abs(candidateRect.x2 - originalRect.x2) < toleranceX;

  const yOverlap =
    Math.abs(candidateRect.y1 - originalRect.y1) < toleranceY &&
    Math.abs(candidateRect.y2 - originalRect.y2) < toleranceY;

  return xOverlap && yOverlap;
}

/**
 * Check if two positions overlap (within 10 pixels)
 */
function positionsOverlap(
  pos1: ScaledPosition,
  pos2: ScaledPosition,
  viewport: Viewport,
): boolean {
  const PIXEL_TOLERANCE = 10;

  // Convert to viewport coordinates for comparison
  const rect1 = pos1.boundingRect;
  const rect2 = pos2.boundingRect;

  // Check if positions are on the same page
  if (pos1.pageNumber !== pos2.pageNumber) {
    return false;
  }

  // Convert scaled to viewport for comparison
  const vp1 = {
    left: (viewport.width * rect1.x1) / rect1.width,
    top: (viewport.height * rect1.y1) / rect1.height,
    right: (viewport.width * rect1.x2) / rect1.width,
    bottom: (viewport.height * rect1.y2) / rect1.height,
  };

  const vp2 = {
    left: (viewport.width * rect2.x1) / rect2.width,
    top: (viewport.height * rect2.y1) / rect2.height,
    right: (viewport.width * rect2.x2) / rect2.width,
    bottom: (viewport.height * rect2.y2) / rect2.height,
  };

  // Check for overlap with tolerance
  const horizontalOverlap = vp1.right + PIXEL_TOLERANCE > vp2.left && vp1.left - PIXEL_TOLERANCE < vp2.right;
  const verticalOverlap = vp1.bottom + PIXEL_TOLERANCE > vp2.top && vp1.top - PIXEL_TOLERANCE < vp2.bottom;

  return horizontalOverlap && verticalOverlap;
}
