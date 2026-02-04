/**
 * Similar section finder using DOM text element comparison
 * Compares actual DOM text layer elements to find structurally similar sections
 */

import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { viewportToScaled } from "./coordinates";
import { extractAllTextElements, findNodeGroupAtPosition, findSimilarNodeGroups, groupTextElementsIntoSections, type TextElementGroup } from "./pdf-node-comparator";
import type { ScaledPosition, SimilarityResult } from "../types";

/**
 * Options for similarity search using DOM node comparison
 */
export interface SimilaritySearchOptions {
  selectedText: string;
  selectedPosition: ScaledPosition;
  pdfDocument: any;
  viewer: PDFViewer;
  threshold?: number; // default 0.60 (60% structural similarity)
  maxResults?: number; // default 20
  maxPages?: number; // default 50
  onProgress?: (current: number, total: number, found: number) => void;
}

/**
 * Find similar sections across a PDF document using DOM text element comparison
 * This method compares the actual rendered DOM elements for more accurate matching
 *
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
    threshold = 0.60,
    maxResults = 20,
    maxPages = 50,
    onProgress,
  } = options;

  // Minimum text length to avoid false positives
  const MIN_TEXT_LENGTH = 10;

  if (!selectedText || selectedText.length < MIN_TEXT_LENGTH) {
    console.log("Text too short for similarity search:", selectedText.length);
    return [];
  }

  // Limit number of pages to search for performance
  const numPages = Math.min(pdfDocument.numPages, maxPages);

  // Get the viewer container for DOM extraction
  const container = viewer.container;
  if (!container) {
    console.error("PDF viewer container not found");
    return [];
  }

  console.log("=== Starting similarity search ===:", {
    selectedText: selectedText.substring(0, 50) + (selectedText.length > 50 ? "..." : ""),
    numPages,
    threshold,
    selectedPosition: {
      pageNumber: selectedPosition.pageNumber,
      boundingRect: selectedPosition.boundingRect,
    },
  });

  // Extract all text elements from DOM
  onProgress?.(0, numPages, 0);

  const elementsMap = await extractAllTextElements(container, numPages, (current, total) => {
    onProgress?.(current, total, 0);
  });

  console.log("=== Extracted text elements ===:", Array.from(elementsMap.entries()).map(([page, elements]) => [page, elements.length]));

  // Group elements into sections (lines/paragraphs)
  const allGroups: TextElementGroup[] = [];
  for (const [pageIndex, elements] of elementsMap.entries()) {
    const groups = groupTextElementsIntoSections(elements);
    console.log(`Page ${pageIndex}: ${groups.length} groups from ${elements.length} elements`);
    allGroups.push(...groups);
  }

  console.log("=== Total groups created:", allGroups.length, "===");

  onProgress?.(numPages, numPages, 0);

  // Find the reference group that matches the selected position
  const pageView = viewer.getPageView(selectedPosition.pageNumber - 1);
  if (!pageView || !pageView.viewport) {
    console.error("Could not get page view for page:", selectedPosition.pageNumber);
    return [];
  }

  const viewport = pageView.viewport;
  console.log("Viewport for page", selectedPosition.pageNumber, ":", { width: viewport.width, height: viewport.height });

  const referenceGroup = findNodeGroupAtPosition(
    allGroups,
    selectedPosition.pageNumber,
    selectedPosition,
    viewport,
  );

  if (!referenceGroup) {
    console.warn("Could not find reference node group at selected position");
    // Log all groups on this page for debugging
    const pageGroups = allGroups.filter(g => g.pageNumber === selectedPosition.pageNumber);
    console.log("Available groups on page", selectedPosition.pageNumber, ":", pageGroups.map(g => ({ text: g.text.substring(0, 30), bounds: g.bounds, signature: g.signature })));
    return [];
  }

  console.log("=== Reference group found ===:", {
    text: referenceGroup.text.substring(0, 50) + (referenceGroup.text.length > 50 ? "..." : ""),
    signature: referenceGroup.signature,
    elementCount: referenceGroup.elements.length,
    bounds: referenceGroup.bounds,
  }, "===");

  // Find similar groups using structural comparison
  const similarGroups = findSimilarNodeGroups(
    referenceGroup,
    allGroups,
    threshold,
    maxResults,
  );

  console.log("=== Similar groups found:", similarGroups.length, "===");

  onProgress?.(numPages, numPages, similarGroups.length);

  // Convert results to the expected format
  const results: SimilarityResult[] = [];

  for (const similar of similarGroups) {
    console.log("Processing similar group:", {
      text: similar.group.text.substring(0, 30) + (similar.group.text.length > 30 ? "..." : ""),
      score: similar.score,
      pageNumber: similar.group.pageNumber,
    });

    // Get the viewport for this page to convert coordinates
    const pageView = viewer.getPageView(similar.group.pageNumber - 1);
    if (!pageView || !pageView.viewport) {
      console.warn("Could not get page view for page:", similar.group.pageNumber);
      continue;
    }

    const viewport = pageView.viewport;

    // Convert the position to scaled coordinates
    const scaledPosition = viewportToScaled(
      {
        left: similar.position.boundingRect.x1,
        top: similar.position.boundingRect.y1,
        width: similar.position.boundingRect.x2 - similar.position.boundingRect.x1,
        height: similar.position.boundingRect.y2 - similar.position.boundingRect.y1,
        pageNumber: similar.group.pageNumber,
      },
      viewport,
    );

    // Convert all rects to scaled coordinates
    const scaledRects = similar.position.rects.map((rect) =>
      viewportToScaled(
        {
          left: rect.x1,
          top: rect.y1,
          width: rect.width,
          height: rect.height,
          pageNumber: similar.group.pageNumber,
        },
        viewport,
      ),
    );

    results.push({
      text: similar.matchedText,
      score: similar.score,
      position: {
        boundingRect: scaledPosition,
        rects: scaledRects,
        pageNumber: similar.group.pageNumber,
      },
    });

    onProgress?.(numPages, numPages, results.length);

    // Stop if we've found enough results
    if (results.length >= maxResults) {
      break;
    }
  }

  console.log("=== Final results:", results.length, "===");

  // Sort by score descending
  return results.sort((a, b) => b.score - a.score);
}
