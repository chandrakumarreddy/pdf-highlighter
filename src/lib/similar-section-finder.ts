/**
 * Similar section finder using DOM text element comparison
 * Compares actual DOM text layer elements to find structurally similar sections
 */

import { viewportToScaled } from "./coordinates";
import {
  extractAllTextElements,
  findNodeGroupAtPosition,
  findSimilarNodeGroups,
  groupTextElementsIntoSections,
  type TextElementGroup,
} from "./pdf-node-comparator";
import type {
  SimilarityResult,
  SimilaritySearchOptions,
} from "../types";

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
    threshold = 0.75,
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

  // Determine the range of pages to search
  // We want to search up to maxPages, centered around the current page
  const totalPages = pdfDocument.numPages;
  const currentPage = selectedPosition.pageNumber;

  let startPage = Math.max(1, currentPage - Math.floor(maxPages / 2));
  let endPage = Math.min(totalPages, startPage + maxPages - 1);

  // Adjust range if we're near the beginning or end
  if (endPage - startPage + 1 < maxPages) {
    if (startPage === 1) {
      endPage = Math.min(totalPages, maxPages);
    } else if (endPage === totalPages) {
      startPage = Math.max(1, totalPages - maxPages + 1);
    }
  }

  const pagesToSearch: number[] = [];
  for (let p = startPage; p <= endPage; p++) {
    pagesToSearch.push(p);
  }

  // Get the viewer container for DOM extraction
  const container = viewer.container;
  if (!container) {
    console.error("PDF viewer container not found");
    return [];
  }

  console.log("=== Starting similarity search ===:", {
    selectedText:
      selectedText.substring(0, 50) + (selectedText.length > 50 ? "..." : ""),
    searchingPages: `${startPage}-${endPage}`,
    totalPages,
    threshold,
    currentPage,
  });

  // Extract text elements from DOM (all pages are now rendered since we disabled virtualization)
  console.log("=== Extracting text elements from DOM ===");
  const elementsMap = extractAllTextElements(
    container,
    pagesToSearch,
    (current, total) => {
      onProgress?.(current, total, 0);
    },
  );
  console.log("=== Text extraction complete ===");

  console.log(
    "=== Extracted text elements from pages ===:",
    Array.from(elementsMap.entries()).map(([page, elements]) => [
      page,
      elements.length,
    ]),
  );

  // Group elements into sections (lines/paragraphs)
  const allGroups: TextElementGroup[] = [];
  for (const [pageIndex, elements] of elementsMap.entries()) {
    console.log(
      `Debug: Processing page ${pageIndex}, elements count: ${elements.length}, first element pageNumber: ${elements[0]?.pageNumber}`,
    );
    const groups = groupTextElementsIntoSections(elements);
    console.log(
      `Debug: Created ${groups.length} groups for page ${pageIndex}, group pageNumbers:`,
      groups.map((g) => g.pageNumber),
    );
    allGroups.push(...groups);
  }

  console.log("=== Total groups created:", allGroups.length, "===");

  // Find the reference group that matches the selected position
  const pageView = viewer.getPageView(currentPage - 1);
  if (!pageView || !pageView.viewport) {
    console.error("Could not get page view for page:", currentPage);
    return [];
  }

  const viewport = pageView.viewport;

  const referenceGroup = findNodeGroupAtPosition(
    allGroups,
    currentPage,
    selectedPosition,
    viewport,
  );

  if (!referenceGroup) {
    console.warn("Could not find reference node group at selected position");
    return [];
  }

  console.log(
    "=== Reference group found ===:",
    {
      text:
        referenceGroup.text.substring(0, 50) +
        (referenceGroup.text.length > 50 ? "..." : ""),
      signature: referenceGroup.signature,
      elementCount: referenceGroup.elements.length,
    },
    "===",
  );

  // Find similar groups using structural comparison
  const similarGroups = findSimilarNodeGroups(
    referenceGroup,
    allGroups,
    threshold,
    maxResults,
  );

  console.log("=== Similar groups found:", similarGroups.length, "===");

  // Convert results to the expected format
  // The convertGroupToViewportCoordinates returns viewport coordinates (left, top, width, height)
  // We convert these to scaled coordinates using viewportToScaled
  const results: SimilarityResult[] = [];

  for (const similar of similarGroups) {
    const sPageView = viewer.getPageView(similar.group.pageNumber - 1);
    if (!sPageView || !sPageView.viewport) continue;

    const sViewport = sPageView.viewport;

    // The position is now in viewport coordinates (left, top, width, height)
    // Convert to scaled coordinates for the highlighter
    const scaledPosition = viewportToScaled(
      {
        left: similar.position.boundingRect.left,
        top: similar.position.boundingRect.top,
        width: similar.position.boundingRect.width,
        height: similar.position.boundingRect.height,
        pageNumber: similar.group.pageNumber,
      },
      sViewport,
    );

    // Convert all rects to scaled coordinates
    const scaledRects = similar.position.rects.map((rect) =>
      viewportToScaled(
        {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          pageNumber: similar.group.pageNumber,
        },
        sViewport,
      ),
    );

    console.log("Similar section rect debug:", {
      pageNumber: similar.group.pageNumber,
      rectsCount: scaledRects.length,
      firstRectPageNumber: scaledRects[0]?.pageNumber,
      boundingRect: scaledPosition,
      firstRect: scaledRects[0],
    });

    results.push({
      text: similar.matchedText,
      score: similar.score,
      position: {
        boundingRect: scaledPosition,
        rects: scaledRects,
        pageNumber: similar.group.pageNumber,
      },
    });

    onProgress?.(pagesToSearch.length, pagesToSearch.length, results.length);

    if (results.length >= maxResults) break;
  }

  console.log("=== Final results:", results.length, "===");

  // Sort by score descending
  return results.sort((a, b) => b.score - a.score);
}
