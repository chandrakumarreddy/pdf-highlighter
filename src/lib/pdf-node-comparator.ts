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
}

/**
 * Similarity result based on node comparison
 */
export interface NodeSimilarityResult {
  group: TextElementGroup;
  score: number;
  position: ScaledPosition;
  matchedText: string;
}

/**
 * Extract text elements from a page's text layer
 */
export function extractTextElementsFromPage(
  container: HTMLElement,
  pageNumber: number,
): TextElementNode[] {
  let pageDiv = container.querySelector(`.page[data-page-number="${pageNumber}"]`) as HTMLElement;
  if (!pageDiv) {
    // Try finding page by index if data-page-number is not set
    const pages = container.querySelectorAll(".page");
    pageDiv = pages[pageNumber - 1] as HTMLElement;
    if (!pageDiv) return [];
  }
  const textLayer = pageDiv.querySelector(".textLayer") as HTMLElement;
  if (!textLayer) return [];

  const textSpans = Array.from(textLayer.querySelectorAll<HTMLElement>("span[role='presentation']"));

  console.log("Extracting text elements from page", pageNumber, {
    pageDivOffsetLeft: pageDiv.offsetLeft,
    pageDivOffsetTop: pageDiv.offsetTop,
    textLayerOffsetLeft: textLayer.offsetLeft,
    textLayerOffsetTop: textLayer.offsetTop,
    pageDivBoundingClientRect: pageDiv.getBoundingClientRect(),
    textLayerFound: !!textLayer,
    textSpanCount: textSpans.length,
  });

  return textSpans
    .filter(span => span.textContent && span.textContent.trim().length > 0)
    .map(span => {
      // Get the position relative to the textLayer (offsetParent)
      const spanLeft = span.offsetLeft;
      const spanTop = span.offsetTop;

      // The textLayer is positioned within the page div, so we need to add its offset
      // to get page-relative coordinates
      const textLayerLeft = textLayer.offsetLeft;
      const textLayerTop = textLayer.offsetTop;

      const computedStyle = window.getComputedStyle(span);
      const fontFamily = computedStyle.fontFamily;
      const fontSize = parseFloat(computedStyle.fontSize);
      const fontWeight = computedStyle.fontWeight;
      const isBold = parseInt(fontWeight) >= 700 || fontWeight === "bold" || fontWeight === "700";

      // Create a rect using page-relative positions
      const pageRelativeRect = new DOMRect(
        textLayerLeft + spanLeft,
        textLayerTop + spanTop,
        span.offsetWidth,
        span.offsetHeight,
      );

      return {
        element: span,
        text: span.textContent || "",
        bounds: pageRelativeRect,
        pageNumber,
        fontFamily,
        fontSize,
        fontWeight,
        isBold,
      };
    });
}

/**
 * Extract all text elements from all pages
 */
export function extractAllTextElements(
  container: HTMLElement,
  numPages: number,
  onProgress?: (current: number, total: number) => void,
): Map<number, TextElementNode[]> {
  const elementsMap = new Map<number, TextElementNode[]>();

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const elements = extractTextElementsFromPage(container, pageNum);
    elementsMap.set(pageNum, elements);
    onProgress?.(pageNum, numPages);
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
    };
  }

  const fontFamilies = new Set(elements.map(e => e.fontFamily));
  const primaryFontFamily = Array.from(fontFamilies)[0] || "";
  const avgFontSize = elements.reduce((sum, e) => sum + e.fontSize, 0) / elements.length;
  const isBold = elements.some(e => e.isBold);
  const textLength = elements.reduce((sum, e) => sum + e.text.length, 0);

  // Calculate line height (Y span of the group)
  const minY = Math.min(...elements.map(e => e.bounds.top));
  const maxY = Math.max(...elements.map(e => e.bounds.bottom));
  const lineHeight = maxY - minY;

  return {
    elementCount: elements.length,
    fontFamily: primaryFontFamily,
    avgFontSize,
    isBold,
    textLength,
    lineHeight,
  };
}

/**
 * Group text elements into logical sections (lines/paragraphs)
 * Groups elements that are on the same line or consecutive lines
 */
export function groupTextElementsIntoSections(
  elements: TextElementNode[],
  maxLineGap: number = 25, // pixels - max gap to consider as next line
  maxColumnGap: number = 100, // pixels - max horizontal gap (columns)
): TextElementGroup[] {
  if (elements.length === 0) return [];

  // Sort elements by Y position (top to bottom)
  const sorted = [...elements].sort((a, b) => a.bounds.top - b.bounds.top);

  const groups: TextElementGroup[] = [];
  let currentGroup: TextElementNode[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const element = sorted[i];
    const groupBounds = getGroupBounds(currentGroup);

    // Check vertical gap
    const verticalGap = element.bounds.top - groupBounds.bottom;

    // Check horizontal alignment (same column)
    const horizontalOverlap = !(element.bounds.right < groupBounds.left - maxColumnGap ||
                                 element.bounds.left > groupBounds.right + maxColumnGap);

    // Same group if: vertically close (next line) AND horizontally aligned
    if (verticalGap >= 0 && verticalGap <= maxLineGap && horizontalOverlap) {
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

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

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
    text: elements.map(e => e.text).join(" "),
    pageNumber: elements[0].pageNumber,
    signature: createSignature(elements),
  };
}

/**
 * Compare two group signatures and return similarity score (0-1)
 */
function compareSignatures(sig1: GroupSignature, sig2: GroupSignature): number {
  let score = 0;
  let weight = 0;

  // Element count similarity (15% weight)
  const countDiff = Math.abs(sig1.elementCount - sig2.elementCount) / Math.max(sig1.elementCount, sig2.elementCount);
  score += (1 - countDiff) * 0.15;
  weight += 0.15;

  // Font size similarity (25% weight) - use 10% tolerance for matching
  const sizeDiff = Math.abs(sig1.avgFontSize - sig2.avgFontSize) / Math.max(sig1.avgFontSize, sig2.avgFontSize);
  score += (1 - Math.min(sizeDiff * 5, 1)) * 0.25; // Scale difference for more forgiving match
  weight += 0.25;

  // Text length similarity (20% weight) - more forgiving
  const lengthRatio = Math.min(sig1.textLength, sig2.textLength) / Math.max(sig1.textLength, sig2.textLength);
  score += lengthRatio * 0.2;
  weight += 0.2;

  // Line height similarity (10% weight)
  const heightDiff = Math.abs(sig1.lineHeight - sig2.lineHeight) / Math.max(sig1.lineHeight, sig2.lineHeight);
  score += (1 - heightDiff) * 0.1;
  weight += 0.1;

  // Font family match (20% weight)
  const fontMatch = sig1.fontFamily === sig2.fontFamily ? 1 : 0;
  score += fontMatch * 0.2;
  weight += 0.2;

  // Bold match (10% weight)
  const boldMatch = sig1.isBold === sig2.isBold ? 1 : 0;
  score += boldMatch * 0.1;
  weight += 0.1;

  return weight > 0 ? score / weight : 0;
}

/**
 * Find similar element groups to a reference group
 */
export function findSimilarNodeGroups(
  referenceGroup: TextElementGroup,
  allGroups: TextElementGroup[],
  threshold: number = 0.60, // Lower threshold for better matching
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
        console.log("Skipping same section (overlap):", group.text, posSimilarity);
        continue; // Skip if position is too similar (same section)
      }
    }

    // Compare structural signatures
    const structuralScore = compareSignatures(referenceGroup.signature, group.signature);

    console.log("Comparison:", {
      candidate: group.text,
      score: structuralScore,
      threshold,
      signature: group.signature,
    });

    if (structuralScore >= threshold) {
      results.push({
        group,
        score: structuralScore,
        position: convertGroupToScaledPosition(group),
        matchedText: group.text,
      });
    }
  }

  console.log("Found similar sections:", results.length);

  // Sort by score descending and limit results
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Compare two bounds for overlap detection
 */
function compareBounds(rect1: DOMRect, rect2: DOMRect): number {
  const overlapX = Math.max(0, Math.min(rect1.right, rect2.right) - Math.max(rect1.left, rect2.left));
  const overlapY = Math.max(0, Math.min(rect1.bottom, rect2.bottom) - Math.max(rect1.top, rect2.top));
  const overlapArea = overlapX * overlapY;

  const area1 = rect1.width * rect1.height;
  const area2 = rect2.width * rect2.height;
  const unionArea = area1 + area2 - overlapArea;

  return unionArea > 0 ? overlapArea / unionArea : 0;
}

/**
 * Convert a text element group to a scaled position for highlighting
 */
function convertGroupToScaledPosition(group: TextElementGroup): ScaledPosition {
  // Create rects from individual elements
  const rects: Array<{ x1: number; y1: number; x2: number; y2: number; width: number; height: number; pageNumber?: number }> = group.elements.map(el => ({
    x1: el.bounds.left,
    y1: el.bounds.top,
    x2: el.bounds.right,
    y2: el.bounds.bottom,
    width: el.bounds.width,
    height: el.bounds.height,
    pageNumber: group.pageNumber,
  }));

  // Calculate bounding rect
  const boundingRect = {
    x1: group.bounds.left,
    y1: group.bounds.top,
    x2: group.bounds.right,
    y2: group.bounds.bottom,
    width: group.bounds.width,
    height: group.bounds.height,
    pageNumber: group.pageNumber,
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
  const targetLeft = (viewport.width * scaledPosition.boundingRect.x1) / scaledPosition.boundingRect.width;
  const targetTop = (viewport.height * scaledPosition.boundingRect.y1) / scaledPosition.boundingRect.height;
  const targetRight = (viewport.width * scaledPosition.boundingRect.x2) / scaledPosition.boundingRect.width;
  const targetBottom = (viewport.height * scaledPosition.boundingRect.y2) / scaledPosition.boundingRect.height;

  const targetRect = new DOMRect(targetLeft, targetTop, targetRight - targetLeft, targetBottom - targetTop);

  // Find groups on the same page
  const pageGroups = allGroups.filter(g => g.pageNumber === pageNumber);

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
