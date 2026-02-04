/**
 * PDF text extraction utilities using PDF.js getTextContent API
 */

import type { PDFPageProxy } from "pdfjs-dist";
import type { LTWHP, Viewport } from "../types";

/**
 * Represents a text item from PDF.js with extended coordinate information
 */
export interface TextItem {
  str: string;
  transform: number[]; // [a, b, c, d, e, f] transformation matrix
  width: number;
  height: number;
  dir: string;
  fontName: string;
  hasEOL: boolean;
  // Calculated viewport coordinates
  x: number;
  y: number;
}

/**
 * Text content for a page with items and concatenated text
 */
export interface PageTextContent {
  items: TextItem[];
  text: string;
}

/**
 * Extract text content from a single PDF page
 * @param page - PDF.js page proxy
 * @returns Page text content with items and concatenated text
 */
export async function extractTextContentFromPage(
  page: PDFPageProxy,
): Promise<PageTextContent> {
  const textContent = await page.getTextContent();

  const items: TextItem[] = textContent.items.map((item) => {
    // PDF.js transform matrix: [a, b, c, d, e, f]
    // where e = x position, f = y position (in PDF space)
    const transform = (item as any).transform || [1, 0, 0, 1, 0, 0];
    const x = transform[4];
    const y = transform[5];

    return {
      str: (item as any).str || "",
      transform,
      width: (item as any).width || 0,
      height: (item as any).height || 0,
      dir: (item as any).dir || "ltr",
      fontName: (item as any).fontName || "",
      hasEOL: (item as any).hasEOL || false,
      x,
      y,
    };
  });

  // Concatenate all text items with spaces
  const text = concatenateTextItems(items);

  return { items, text };
}

/**
 * Concatenate text items into a single string
 * @param items - Array of text items
 * @returns Concatenated text string
 */
export function concatenateTextItems(items: TextItem[]): string {
  return items.map((item) => item.str).join(" ");
}

/**
 * Extract text content from all pages in a PDF document
 * @param pdfDocument - PDF.js document proxy
 * @param onProgress - Optional callback for progress updates
 * @returns Map of page number to page text content
 */
export async function extractAllTextContent(
  pdfDocument: any,
  onProgress?: (current: number, total: number) => void,
): Promise<Map<number, PageTextContent>> {
  const numPages = pdfDocument.numPages;
  const pagesMap = new Map<number, PageTextContent>();

  // Process pages in batches to avoid blocking UI
  const BATCH_SIZE = 5;

  for (let i = 1; i <= numPages; i += BATCH_SIZE) {
    const batch = [];
    const endIndex = Math.min(i + BATCH_SIZE, numPages + 1);

    for (let pageNum = i; pageNum < endIndex; pageNum++) {
      batch.push(
        pdfDocument.getPage(pageNum).then(async (page: PDFPageProxy) => {
          const content = await extractTextContentFromPage(page);
          pagesMap.set(pageNum, content);
        }),
      );
    }

    await Promise.all(batch);

    if (onProgress) {
      onProgress(Math.min(endIndex - 1, numPages), numPages);
    }

    // Yield to UI thread
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return pagesMap;
}

/**
 * Convert PDF text item coordinates to viewport rectangle
 * @param textItems - Array of text items
 * @param viewport - PDF.js viewport
 * @returns Viewport rectangle (LTWHP)
 */
export function textItemsToPosition(
  textItems: TextItem[],
  viewport: Viewport,
): LTWHP {
  if (textItems.length === 0) {
    throw new Error("Cannot create position from empty text items");
  }

  // Get the viewport dimensions
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;

  // Convert PDF coordinates to viewport coordinates
  const viewportRects: Array<{ left: number; top: number; width: number; height: number }> =
    [];

  for (const item of textItems) {
    // Use PDF.js viewport conversion
    // PDF coordinates need to be converted to viewport coordinates
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
      item.x,
      item.y - item.height, // PDF coordinates start from bottom-left
      item.x + item.width,
      item.y,
    ]);

    viewportRects.push({
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y1 - y2),
    });
  }

  // Calculate bounding rectangle
  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;

  for (const rect of viewportRects) {
    minLeft = Math.min(minLeft, rect.left);
    minTop = Math.min(minTop, rect.top);
    maxRight = Math.max(maxRight, rect.left + rect.width);
    maxBottom = Math.max(maxBottom, rect.top + rect.height);
  }

  return {
    left: minLeft,
    top: minTop,
    width: maxRight - minLeft,
    height: maxBottom - minTop,
  };
}

/**
 * Create rects array from text items for highlight rendering
 * @param textItems - Array of text items
 * @param viewport - PDF.js viewport
 * @returns Array of viewport rectangles
 */
export function textItemsToRects(textItems: TextItem[], viewport: Viewport): LTWHP[] {
  return textItems.map((item) => {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
      item.x,
      item.y - item.height,
      item.x + item.width,
      item.y,
    ]);

    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y1 - y2),
    };
  });
}

/**
 * Find text items that correspond to a text range
 * @param allItems - All text items on the page
 * @param startIndex - Start index in the concatenated text
 * @param endIndex - End index in the concatenated text
 * @returns Array of text items that fall within the range
 */
export function findTextItemsInRange(
  allItems: TextItem[],
  startIndex: number,
  endIndex: number,
): TextItem[] {
  let currentPosition = 0;
  const matchingItems: TextItem[] = [];

  for (const item of allItems) {
    const itemLength = item.str.length;

    // Check if this item overlaps with our range
    const itemEndPosition = currentPosition + itemLength;

    if (
      itemEndPosition > startIndex &&
      currentPosition < endIndex &&
      item.str.trim().length > 0
    ) {
      matchingItems.push(item);
    }

    currentPosition += itemLength + 1; // +1 for space

    if (currentPosition > endIndex) {
      break;
    }
  }

  return matchingItems;
}
