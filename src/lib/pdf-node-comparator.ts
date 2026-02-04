/**
 * PDF Node Comparator - Find similar sections by comparing PDF text rendering nodes
 * Uses the actual DOM text layer elements for accurate position matching
 */

import type { ScaledPosition } from "../types";

/**
 * Represents a text element from the DOM text layer
 */
export interface TextElementNode {
  element: HTMLElement;
  text: string;
  bounds: DOMRect;
  pageNumber: number;
  // Font properties computed from computed style
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  isBold: boolean;
}

/**
 * A group of text elements representing a section (line/paragraph)
 */
export interface TextElementGroup {
  elements: TextElementNode[];
  bounds: DOMRect;
  text: string;
  pageNumber: number;
  // Structural signature for comparison
  signature: GroupSignature;
}

/**
 * Structural signature of a text element group
 */
export interface GroupSignature {
  elementCount: number;
  fontFamily: string;
  avgFontSize: number;
  isBold: boolean;
  textLength: number;
  lineHeight: number;
  // Horizontal position for column-based matching
  left: number;
}

/**
 * Similarity result based on node comparison
 * Position is in viewport coordinates (left, top, width, height format)
 */
export interface NodeSimilarityResult {
  group: TextElementGroup;
  score: number;
  position: {
    boundingRect: { left: number; top: number; width: number; height: number };
    rects: Array<{ left: number; top: number; width: number; height: number }>;
    pageNumber: number;
  };
  matchedText: string;
}

/**
 * Helper function to get a page element by page number
 */
function getPageElement(
  container: HTMLElement,
  pageNumber: number,
): HTMLElement | null {
  // First try by data-page-number attribute
  let pageDiv = container.querySelector(
    `.page[data-page-number="${pageNumber}"]`,
  ) as HTMLElement;
  if (!pageDiv) {
    // Fall back to index-based selection
    const pages = container.querySelectorAll(".page");
    pageDiv = pages[pageNumber - 1] as HTMLElement;
  }
  return pageDiv;
}

/**
 * Extract text elements from a page's text layer
 */
export function extractTextElementsFromPage(
  container: HTMLElement,
  pageNumber: number,
): TextElementNode[] {
  const pageDiv = getPageElement(container, pageNumber);
  if (!pageDiv) return [];

  const textLayer = pageDiv.querySelector(".textLayer") as HTMLElement;
  if (!textLayer) return [];

  const textSpans = Array.from(
    textLayer.querySelectorAll<HTMLElement>("span[role='presentation']"),
  );

  if (textSpans.length === 0) return [];

  // Determine if we need to use computed style or if inline styles are enough
  // Most PDF.js implementations use inline styles for positioning and fonts
  return textSpans
    .filter((span) => span.textContent && span.textContent.trim().length > 0)
    .map((span) => {
      // Get the position relative to the textLayer (offsetParent)
      const spanLeft = span.offsetLeft;
      const spanTop = span.offsetTop;

      // The textLayer is positioned within the page div, so we need to add its offset
      // to get page-relative coordinates
      const textLayerLeft = textLayer.offsetLeft;
      const textLayerTop = textLayer.offsetTop;

      // Optimization: Try to get font info from inline styles first
      let fontFamily = span.style.fontFamily;
      let fontSize = parseFloat(span.style.fontSize);
      let fontWeight = span.style.fontWeight;

      // Fallback to computed style only if inline styles are missing
      if (!fontFamily || isNaN(fontSize) || !fontWeight) {
        const computedStyle = window.getComputedStyle(span);
        fontFamily = fontFamily || computedStyle.fontFamily;
        fontSize = isNaN(fontSize)
          ? parseFloat(computedStyle.fontSize)
          : fontSize;
        fontWeight = fontWeight || computedStyle.fontWeight;
      }

      const isBold =
        parseInt(fontWeight) >= 700 ||
        fontWeight === "bold" ||
        fontWeight === "700";

      // Create a rect using page-relative positions
      const pageRelativeRect = new DOMRect(
        textLayerLeft + spanLeft,
        textLayerTop + spanTop,
        span.offsetWidth || span.getBoundingClientRect().width, // Use BoundingClientRect as fallback for width
        span.offsetHeight || span.getBoundingClientRect().height,
      );

      return {
        element: span,
        text: span.textContent || "",
        bounds: pageRelativeRect,
        pageNumber,
        fontFamily,
        fontSize: isNaN(fontSize) ? 0 : fontSize,
        fontWeight,
        isBold,
      };
    });
}

/**
 * Extract all text elements from specified pages
 */
export function extractAllTextElements(
  container: HTMLElement,
  pageNumbers: number[],
  onProgress?: (current: number, total: number) => void,
): Map<number, TextElementNode[]> {
  const elementsMap = new Map<number, TextElementNode[]>();
  const total = pageNumbers.length;

  for (let i = 0; i < pageNumbers.length; i++) {
    const pageNum = pageNumbers[i];
    const elements = extractTextElementsFromPage(container, pageNum);
    elementsMap.set(pageNum, elements);
    onProgress?.(i + 1, total);
  }

  return elementsMap;
}

/**
 * Create a signature for a text element group
 */
function createSignature(elements: TextElementNode[]): GroupSignature {
  if (elements.length === 0) {
    return {
      elementCount: 0,
      fontFamily: "",
      avgFontSize: 0,
      isBold: false,
      textLength: 0,
      lineHeight: 0,
      left: 0,
    };
  }

  const fontFamilies = new Set(elements.map((e) => e.fontFamily));
  const primaryFontFamily = Array.from(fontFamilies)[0] || "";
  const avgFontSize =
    elements.reduce((sum, e) => sum + e.fontSize, 0) / elements.length;
  const isBold = elements.some((e) => e.isBold);
  const textLength = elements.reduce((sum, e) => sum + e.text.length, 0);

  // Calculate line height (Y span of the group)
  const minY = Math.min(...elements.map((e) => e.bounds.top));
  const maxY = Math.max(...elements.map((e) => e.bounds.bottom));
  const lineHeight = maxY - minY;

  // Calculate left position (X coordinate) for column-based matching
  const minX = Math.min(...elements.map((e) => e.bounds.left));

  return {
    elementCount: elements.length,
    fontFamily: primaryFontFamily,
    avgFontSize,
    isBold,
    textLength,
    lineHeight,
    left: minX,
  };
}

/**
 * Group text elements into logical sections (lines/paragraphs)
 * Groups elements that are on the same line or consecutive lines
 * Improved to handle multi-column layouts and wrapped text
 */
export function groupTextElementsIntoSections(
  elements: TextElementNode[],
  maxLineGap: number = 30, // pixels - max gap to consider as next line (increased from 25)
  maxColumnGap: number = 150, // pixels - max horizontal gap (increased from 100 for better column handling)
): TextElementGroup[] {
  if (elements.length === 0) return [];

  // Sort elements by Y position first, then by X position (top to bottom, left to right)
  const sorted = [...elements].sort((a, b) => {
    const yDiff = a.bounds.top - b.bounds.top;
    if (Math.abs(yDiff) < 5) {
      // Same row (within 5px), sort by X
      return a.bounds.left - b.bounds.left;
    }
    return yDiff;
  });

  const groups: TextElementGroup[] = [];
  let currentGroup: TextElementNode[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const element = sorted[i];
    const groupBounds = getGroupBounds(currentGroup);

    // Check vertical gap (how far below is this element?)
    const verticalGap = element.bounds.top - groupBounds.bottom;

    // Check if element is on same line (overlapping Y range)
    const onSameLine =
      element.bounds.top <= groupBounds.bottom &&
      element.bounds.bottom >= groupBounds.top;

    // Check horizontal alignment - more flexible for multi-column layouts
    // Allow larger gaps for columns, but still try to detect column breaks
    const horizontalOverlap = !(
      element.bounds.right < groupBounds.left - maxColumnGap ||
      element.bounds.left > groupBounds.right + maxColumnGap
    );

    // Same group if:
    // 1. On same line (wrapped text within a line) OR
    // 2. Vertically close (next line) AND horizontally aligned (same column/paragraph)
    if (
      onSameLine ||
      (verticalGap >= 0 && verticalGap <= maxLineGap && horizontalOverlap)
    ) {
      currentGroup.push(element);
    } else {
      // Start new group
      if (currentGroup.length > 0) {
        groups.push(createElementGroup(currentGroup));
      }
      currentGroup = [element];
    }
  }

  // Add the last group
  if (currentGroup.length > 0) {
    groups.push(createElementGroup(currentGroup));
  }

  return groups;
}

/**
 * Get bounding box for a group of elements
 */
function getGroupBounds(elements: TextElementNode[]): DOMRect {
  if (elements.length === 0) {
    return new DOMRect(0, 0, 0, 0);
  }

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const el of elements) {
    minX = Math.min(minX, el.bounds.left);
    minY = Math.min(minY, el.bounds.top);
    maxX = Math.max(maxX, el.bounds.right);
    maxY = Math.max(maxY, el.bounds.bottom);
  }

  return new DOMRect(minX, minY, maxX - minX, maxY - minY);
}

/**
 * Create a text element group from an array of elements
 */
function createElementGroup(elements: TextElementNode[]): TextElementGroup {
  const bounds = getGroupBounds(elements);

  return {
    elements,
    bounds,
    text: elements.map((e) => e.text).join(" "),
    pageNumber: elements[0].pageNumber,
    signature: createSignature(elements),
  };
}

/**
 * Compare two group signatures and return similarity score (0-1)
 * More flexible comparison to handle document variations
 * Now includes horizontal position for column-based matching
 */
function compareSignatures(sig1: GroupSignature, sig2: GroupSignature, text1?: string, text2?: string): number {
  let score = 0;
  let weight = 0;

  // Horizontal position similarity (25% weight) - KEY for column-based matching
  // Use a tolerance of 20px for "same column" determination
  const COLUMN_TOLERANCE = 20;
  const horizontalDiff = Math.abs(sig1.left - sig2.left);
  const horizontalSimilarity = horizontalDiff < COLUMN_TOLERANCE ? 1 : Math.max(0, 1 - horizontalDiff / 200);
  score += horizontalSimilarity * 0.25;
  weight += 0.25;

  // Element count similarity (10% weight) - more forgiving
  const countDiff =
    Math.abs(sig1.elementCount - sig2.elementCount) /
    Math.max(sig1.elementCount, sig2.elementCount);
  score += (1 - Math.min(countDiff * 2, 1)) * 0.1; // More forgiving - allows 2x difference
  weight += 0.1;

  // Font size similarity (15% weight) - more tolerant
  const sizeDiff =
    Math.abs(sig1.avgFontSize - sig2.avgFontSize) /
    Math.max(sig1.avgFontSize, sig2.avgFontSize);
  score += (1 - Math.min(sizeDiff * 3, 1)) * 0.15; // More forgiving
  weight += 0.15;

  // Text content similarity (15% weight) - REDUCED from 30% to 15%
  // This allows column-based matching even when text content differs
  if (text1 && text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (words1.size > 0 && words2.size > 0) {
      // Jaccard similarity: intersection / union
      const intersection = new Set([...words1].filter(x => words2.has(x)));
      const union = new Set([...words1, ...words2]);
      const textSimilarity = union.size > 0 ? intersection.size / union.size : 0;
      score += textSimilarity * 0.15;
      weight += 0.15;
    } else {
      // If one has no significant words, use text length ratio instead
      const lengthRatio =
        Math.min(sig1.textLength, sig2.textLength) /
        Math.max(sig1.textLength, sig2.textLength);
      score += lengthRatio * 0.15;
      weight += 0.15;
    }
  } else {
    // Fall back to text length similarity if text not provided
    const lengthRatio =
      Math.min(sig1.textLength, sig2.textLength) /
      Math.max(sig1.textLength, sig2.textLength);
    score += Math.pow(lengthRatio, 0.5) * 0.15; // Use square root to be more forgiving of length differences
    weight += 0.15;
  }

  // Line height similarity (10% weight) - more forgiving for different line spacing
  const heightDiff =
    Math.abs(sig1.lineHeight - sig2.lineHeight) /
    Math.max(sig1.lineHeight, sig2.lineHeight);
  score += (1 - Math.min(heightDiff * 2, 1)) * 0.1; // More forgiving
  weight += 0.1;

  // Font family match (20% weight) - partial match for similar fonts
  let fontMatch = 0;
  if (sig1.fontFamily === sig2.fontFamily) {
    fontMatch = 1;
  } else {
    // Check if font families are similar (e.g., both are serif or sans-serif)
    const bothSerif =
      sig1.fontFamily.toLowerCase().includes("serif") &&
      sig2.fontFamily.toLowerCase().includes("serif");
    const bothSans =
      sig1.fontFamily.toLowerCase().includes("sans") &&
      sig2.fontFamily.toLowerCase().includes("sans");
    const bothTimes =
      sig1.fontFamily.toLowerCase().includes("times") &&
      sig2.fontFamily.toLowerCase().includes("times");
    const bothArial =
      sig1.fontFamily.toLowerCase().includes("arial") &&
      sig2.fontFamily.toLowerCase().includes("arial");
    if (bothSerif || bothSans || bothTimes || bothArial) {
      fontMatch = 0.7; // Partial match for similar font families
    }
  }
  score += fontMatch * 0.2;
  weight += 0.2;

  // Bold match (15% weight) - increased weight
  const boldMatch = sig1.isBold === sig2.isBold ? 1 : 0;
  score += boldMatch * 0.15;
  weight += 0.15;

  const finalScore = weight > 0 ? score / weight : 0;

  // Relaxed text similarity requirement for column-based matching
  // Only apply strict text filtering if NOT in the same column
  // If horizontal positions are similar (same column), allow matches with lower text similarity
  if (horizontalSimilarity < 0.8) {
    // Not in the same column, require some text similarity
    if (text1 && text2) {
      const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 3));

      if (words1.size > 0 && words2.size > 0) {
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);
        const textSimilarity = union.size > 0 ? intersection.size / union.size : 0;

        // Require at least 15% word overlap for sections NOT in same column
        if (textSimilarity < 0.15) {
          console.log("Rejecting match due to low text similarity (different column):", {
            text1: text1.substring(0, 30),
            text2: text2.substring(0, 30),
            textSimilarity,
            horizontalDiff,
          });
          return 0; // Reject match
        }
      }
    }
  }

  return finalScore;
}

/**
 * Find similar element groups to a reference group
 */
export function findSimilarNodeGroups(
  referenceGroup: TextElementGroup,
  allGroups: TextElementGroup[],
  threshold: number = 0.6, // Lower threshold for better matching
  maxResults: number = 20,
): NodeSimilarityResult[] {
  console.log("Finding similar groups for:", {
    reference: referenceGroup.text,
    signature: referenceGroup.signature,
    totalGroups: allGroups.length,
  });

  const results: NodeSimilarityResult[] = [];

  for (const group of allGroups) {
    // Skip if it's the same page and similar position (likely the same section)
    if (group.pageNumber === referenceGroup.pageNumber) {
      const posSimilarity = compareBounds(referenceGroup.bounds, group.bounds);
      if (posSimilarity > 0.3) {
        console.log(
          "Skipping same section (overlap):",
          group.text,
          posSimilarity,
        );
        continue; // Skip if position is too similar (same section)
      }
    }

    // Compare structural signatures
    const structuralScore = compareSignatures(
      referenceGroup.signature,
      group.signature,
      referenceGroup.text,
      group.text,
    );

    console.log("Comparison:", {
      candidate: group.text,
      reference: referenceGroup.text,
      score: structuralScore,
      threshold,
      signature: group.signature,
    });

    if (structuralScore >= threshold) {
      results.push({
        group,
        score: structuralScore,
        position: convertGroupToViewportCoordinates(group),
        matchedText: group.text,
      });
    }
  }

  console.log("Found similar sections:", results.length);

  // Sort by score descending and limit results
  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/**
 * Compare two bounds for overlap detection
 */
function compareBounds(rect1: DOMRect, rect2: DOMRect): number {
  const overlapX = Math.max(
    0,
    Math.min(rect1.right, rect2.right) - Math.max(rect1.left, rect2.left),
  );
  const overlapY = Math.max(
    0,
    Math.min(rect1.bottom, rect2.bottom) - Math.max(rect1.top, rect2.top),
  );
  const overlapArea = overlapX * overlapY;

  const area1 = rect1.width * rect1.height;
  const area2 = rect2.width * rect2.height;
  const unionArea = area1 + area2 - overlapArea;

  return unionArea > 0 ? overlapArea / unionArea : 0;
}

/**
 * Convert a text element group to viewport coordinates for highlighting
 * Returns viewport-relative coordinates (left, top, width, height format)
 * that can be converted to scaled positions using viewportToScaled
 */
function convertGroupToViewportCoordinates(group: TextElementGroup): {
  boundingRect: { left: number; top: number; width: number; height: number };
  rects: Array<{ left: number; top: number; width: number; height: number }>;
  pageNumber: number;
} {
  // Create rects from individual elements in viewport coordinates
  const rects: Array<{
    left: number;
    top: number;
    width: number;
    height: number;
  }> = group.elements.map((el) => ({
    left: el.bounds.left,
    top: el.bounds.top,
    width: el.bounds.width,
    height: el.bounds.height,
  }));

  // Calculate bounding rect in viewport coordinates
  const boundingRect = {
    left: group.bounds.left,
    top: group.bounds.top,
    width: group.bounds.width,
    height: group.bounds.height,
  };

  return {
    boundingRect,
    rects,
    pageNumber: group.pageNumber,
  };
}

/**
 * Find the text element group that matches a selected text position
 * Uses page-relative coordinates for accurate matching
 */
export function findNodeGroupAtPosition(
  allGroups: TextElementGroup[],
  pageNumber: number,
  scaledPosition: ScaledPosition,
  viewport: { width: number; height: number },
): TextElementGroup | null {
  // Convert scaled position to page-relative viewport coordinates
  // The scaled position uses normalized coordinates (0-1) relative to the viewport
  // Following the scaledToViewport formula: x = (viewportCoord * scaledVal) / scaledSize
  const targetLeft =
    (viewport.width * scaledPosition.boundingRect.x1) /
    scaledPosition.boundingRect.width;
  const targetTop =
    (viewport.height * scaledPosition.boundingRect.y1) /
    scaledPosition.boundingRect.height;
  const targetRight =
    (viewport.width * scaledPosition.boundingRect.x2) /
    scaledPosition.boundingRect.width;
  const targetBottom =
    (viewport.height * scaledPosition.boundingRect.y2) /
    scaledPosition.boundingRect.height;

  const targetRect = new DOMRect(
    targetLeft,
    targetTop,
    targetRight - targetLeft,
    targetBottom - targetTop,
  );

  // Find groups on the same page
  const pageGroups = allGroups.filter((g) => g.pageNumber === pageNumber);

  // Debug: Log all unique page numbers in allGroups
  const uniquePageNumbers = [...new Set(allGroups.map((g) => g.pageNumber))];
  console.log("Debug: All group page numbers:", uniquePageNumbers);
  console.log(
    "Debug: Looking for page:",
    pageNumber,
    "type:",
    typeof pageNumber,
  );
  console.log(
    "Debug: Sample group pageNumber types:",
    allGroups.slice(0, 3).map((g) => ({
      pageNum: g.pageNumber,
      type: typeof g.pageNumber,
      text: g.text.substring(0, 20),
    })),
  );

  console.log("Finding group at position:", {
    pageNumber,
    scaledPosition: {
      x1: scaledPosition.boundingRect.x1,
      y1: scaledPosition.boundingRect.y1,
      x2: scaledPosition.boundingRect.x2,
      y2: scaledPosition.boundingRect.y2,
      width: scaledPosition.boundingRect.width,
      height: scaledPosition.boundingRect.height,
    },
    viewport: { width: viewport.width, height: viewport.height },
    targetRect: {
      left: targetRect.left,
      top: targetRect.top,
      right: targetRect.right,
      bottom: targetRect.bottom,
    },
    pageGroupsCount: pageGroups.length,
  });

  // Find the group with maximum overlap
  let bestMatch: TextElementGroup | null = null;
  let bestOverlap = 0;

  for (const group of pageGroups) {
    const overlap = compareBounds(targetRect, group.bounds);

    console.log("Comparing with group:", {
      text: group.text.substring(0, 30),
      groupBounds: {
        left: group.bounds.left,
        top: group.bounds.top,
        right: group.bounds.right,
        bottom: group.bounds.bottom,
      },
      overlap,
    });

    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = group;
    }
  }

  if (bestMatch) {
    console.log("Found best match:", {
      text: bestMatch.text,
      overlap: bestOverlap,
      signature: bestMatch.signature,
    });
  } else {
    console.warn("No matching group found for position");
  }

  return bestMatch;
}
