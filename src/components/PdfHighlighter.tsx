import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EventBus, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import type { PDFViewerOptions } from "pdfjs-dist/types/web/pdf_viewer";
import React, {
  type PointerEventHandler,
  PureComponent,
  type RefObject,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import { debounce } from "ts-debounce";
import { scaledToViewport, viewportToScaled } from "../lib/coordinates";
import { getAreaAsPNG } from "../lib/get-area-as-png";
import { getBoundingRect } from "../lib/get-bounding-rect";
import { getClientRects } from "../lib/get-client-rects";
import {
  findOrCreateContainerLayer,
  getPageFromElement,
  getPagesFromRange,
  getWindow,
  isHTMLElement,
} from "../lib/pdfjs-dom";
import { findSimilarSections } from "../lib/similar-section-finder";
import styles from "../style/PdfHighlighter.module.css";
import type {
  IHighlight,
  LTWH,
  LTWHP,
  Position,
  Scaled,
  ScaledPosition,
  SimilarityResult,
  SimilaritySearchOptions,
} from "../types";
import { HighlightLayer } from "./HighlightLayer";
import { MouseSelection } from "./MouseSelection";
import { TipContainer } from "./TipContainer";

export type T_ViewportHighlight<T_HT> = { position: Position } & T_HT;

interface State<T_HT> {
  ghostHighlight: {
    position: ScaledPosition;
    content?: { text?: string; image?: string };
  } | null;
  isCollapsed: boolean;
  range: Range | null;
  tip: {
    highlight: T_ViewportHighlight<T_HT>;
    callback: (highlight: T_ViewportHighlight<T_HT>) => JSX.Element;
  } | null;
  tipPosition: Position | null;
  tipChildren: JSX.Element | null;
  isAreaSelectionInProgress: boolean;
  scrolledToHighlightId: string;
}

interface Props<T_HT> {
  highlightTransform: (
    highlight: T_ViewportHighlight<T_HT>,
    index: number,
    setTip: (
      highlight: T_ViewportHighlight<T_HT>,
      callback: (highlight: T_ViewportHighlight<T_HT>) => JSX.Element,
    ) => void,
    hideTip: () => void,
    viewportToScaled: (rect: LTWHP) => Scaled,
    screenshot: (position: LTWH) => string,
    isScrolledTo: boolean,
  ) => JSX.Element;
  highlights: Array<T_HT>;
  onScrollChange: () => void;
  scrollRef?: (scrollTo: (highlight: T_HT) => void) => void;
  pdfDocument: PDFDocumentProxy;
  pdfScaleValue: string;
  onSelectionFinished: (
    position: ScaledPosition,
    content: { text?: string; image?: string },
    hideTipAndSelection: () => void,
    transformSelection: () => void,
  ) => JSX.Element | null;
  enableAreaSelection: (event: MouseEvent) => boolean;
  pdfViewerOptions?: PDFViewerOptions;
}

const EMPTY_ID = "empty-id";

export class PdfHighlighter<T_HT extends IHighlight> extends PureComponent<
  Props<T_HT>,
  State<T_HT>
> {
  static defaultProps = {
    pdfScaleValue: "page-width",
  };

  state: State<T_HT> = {
    ghostHighlight: null,
    isCollapsed: true,
    range: null,
    scrolledToHighlightId: EMPTY_ID,
    isAreaSelectionInProgress: false,
    tip: null,
    tipPosition: null,
    tipChildren: null,
  };

  viewer!: PDFViewer;

  resizeObserver: ResizeObserver | null = null;
  containerNode?: HTMLDivElement | null = null;
  containerNodeRef: RefObject<HTMLDivElement>;
  highlightRoots: {
    [page: number]: { reactRoot: Root; container: Element };
  } = {};
  unsubscribe = () => {};
  private scrollTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isHandlingParagraphClick = false;
  private paragraphClickHandlerRef: { current: ((e: Event) => void) | null } = {
    current: null,
  };
  // Cache span positions per textLayer for performance
  private spanCache = new Map<Element, Array<{ el: HTMLElement; rect: DOMRect }>>();
  // Track visible page numbers for viewport-based rendering
  private visiblePageNumbers = new Set<number>();
  private viewportObserver: IntersectionObserver | null = null;
  // Cache for grouped highlights to avoid re-computation
  private highlightGroupCache = new Map<string, ReturnType<typeof this.groupHighlightsByPage>>();

  constructor(props: Props<T_HT>) {
    super(props);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.debouncedScaleValue);
    }
    this.containerNodeRef = React.createRef();
  }

  componentDidMount() {
    this.init();
  }

  attachRef = (eventBus: EventBus) => {
    const { resizeObserver: observer } = this;
    this.containerNode = this.containerNodeRef.current;
    this.unsubscribe();

    if (this.containerNode) {
      const { ownerDocument: doc } = this.containerNode;
      eventBus.on("textlayerrendered", this.onTextLayerRendered);
      eventBus.on("pagesinit", this.onDocumentReady);
      doc.addEventListener("selectionchange", this.onSelectionChange);
      doc.addEventListener("keydown", this.handleKeyDown);
      doc.defaultView?.addEventListener("resize", this.debouncedScaleValue);
      if (observer) observer.observe(this.containerNode);

      // Set up paragraph click handler once (not on every textlayerrendered)
      this.setupParagraphClickHandler();

      // Set up viewport observer for performance
      this.setupViewportObserver();

      this.unsubscribe = () => {
        eventBus.off("pagesinit", this.onDocumentReady);
        eventBus.off("textlayerrendered", this.onTextLayerRendered);
        doc.removeEventListener("selectionchange", this.onSelectionChange);
        doc.removeEventListener("keydown", this.handleKeyDown);
        doc.defaultView?.removeEventListener(
          "resize",
          this.debouncedScaleValue,
        );
        if (observer) observer.disconnect();

        // Cleanup viewport observer
        if (this.viewportObserver) {
          this.viewportObserver.disconnect();
          this.viewportObserver = null;
        }

        // Cleanup paragraph click handler
        if (this.paragraphClickHandlerRef.current && this.containerNode) {
          this.containerNode.removeEventListener("click", this.paragraphClickHandlerRef.current);
        }

        // Clear span cache
        this.spanCache.clear();
      };
    }
  };

  componentDidUpdate(prevProps: Props<T_HT>) {
    if (prevProps.pdfDocument !== this.props.pdfDocument) {
      this.init();
      return;
    }
    if (prevProps.highlights !== this.props.highlights) {
      this.renderHighlightLayers();
    }
  }

  async init() {
    const { pdfDocument, pdfViewerOptions } = this.props;
    const pdfjs = await import("pdfjs-dist/web/pdf_viewer.mjs");

    const eventBus = new pdfjs.EventBus();
    const linkService = new pdfjs.PDFLinkService({
      eventBus,
      externalLinkTarget: 2,
    });

    if (!this.containerNodeRef.current) {
      throw new Error("!");
    }

    this.viewer =
      this.viewer ||
      new pdfjs.PDFViewer({
        container: this.containerNodeRef.current,
        eventBus: eventBus,
        // enhanceTextSelection: true, // deprecated. https://github.com/mozilla/pdf.js/issues/9943#issuecomment-409369485
        textLayerMode: 2,
        removePageBorders: true,
        linkService: linkService,
        ...pdfViewerOptions,
      });

    linkService.setDocument(pdfDocument);
    linkService.setViewer(this.viewer);
    this.viewer.setDocument(pdfDocument);

    this.attachRef(eventBus);
  }

  componentWillUnmount() {
    this.unsubscribe();
    // Clear any pending scroll timeout
    if (this.scrollTimeoutId !== null) {
      clearTimeout(this.scrollTimeoutId);
    }
    // Unmount all React roots to prevent memory leaks
    for (const pageNumber in this.highlightRoots) {
      const rootData = this.highlightRoots[pageNumber];
      try {
        rootData.reactRoot.unmount();
      } catch {
        // Ignore errors during unmount
      }
    }
    this.highlightRoots = {};
  }

  findOrCreateHighlightLayer(page: number) {
    const { textLayer } = this.viewer.getPageView(page - 1) || {};

    if (!textLayer) {
      return null;
    }

    return findOrCreateContainerLayer(
      textLayer.div,
      `PdfHighlighter__highlight-layer ${styles.highlightLayer}`,
      ".PdfHighlighter__highlight-layer",
    );
  }

  groupHighlightsByPage(highlights: Array<T_HT>): {
    [pageNumber: string]: Array<T_HT>;
  } {
    const { ghostHighlight } = this.state;

    // Create a hash for the current highlights to check cache
    const highlightsHash = this.createHighlightsHash(highlights, ghostHighlight);

    // Check cache
    if (this.highlightGroupCache.has(highlightsHash)) {
      return this.highlightGroupCache.get(highlightsHash)!;
    }

    const allHighlights = [...highlights, ghostHighlight].filter(
      Boolean,
    ) as T_HT[];

    const pageNumbers = new Set<number>();
    for (const highlight of allHighlights) {
      pageNumbers.add(highlight.position.pageNumber);
      for (const rect of highlight.position.rects) {
        if (rect.pageNumber) {
          pageNumbers.add(rect.pageNumber);
        }
      }
    }

    const groupedHighlights: Record<number, T_HT[]> = {};

    for (const pageNumber of pageNumbers) {
      groupedHighlights[pageNumber] = groupedHighlights[pageNumber] || [];
      for (const highlight of allHighlights) {
        const pageSpecificHighlight = {
          ...highlight,
          position: {
            pageNumber,
            boundingRect: highlight.position.boundingRect,
            rects: [],
            usePdfCoordinates: highlight.position.usePdfCoordinates,
          } as ScaledPosition,
        };
        let anyRectsOnPage = false;
        for (const rect of highlight.position.rects) {
          if (
            pageNumber === (rect.pageNumber || highlight.position.pageNumber)
          ) {
            pageSpecificHighlight.position.rects.push(rect);
            anyRectsOnPage = true;
          }
        }
        if (anyRectsOnPage || pageNumber === highlight.position.pageNumber) {
          groupedHighlights[pageNumber].push(pageSpecificHighlight);
        }
      }
    }

    // Cache the result
    this.highlightGroupCache.set(highlightsHash, groupedHighlights);

    // Clean up old cache entries (keep only last 5)
    if (this.highlightGroupCache.size > 5) {
      const firstKey = this.highlightGroupCache.keys().next().value;
      if (firstKey) {
        this.highlightGroupCache.delete(firstKey);
      }
    }

    return groupedHighlights;
  }

  // Create a hash for cache invalidation
  private createHighlightsHash(highlights: Array<T_HT>, ghostHighlight: State<T_HT>['ghostHighlight']): string {
    const ids = highlights.map(h => h.id ?? 'unknown').join('-');
    const ghostId = ghostHighlight ? 'ghost' : 'none';
    return `${ids}-${ghostId}`;
  }

  showTip(highlight: T_ViewportHighlight<T_HT>, content: JSX.Element) {
    const { isCollapsed, ghostHighlight, isAreaSelectionInProgress } =
      this.state;

    const highlightInProgress = !isCollapsed || ghostHighlight;

    if (highlightInProgress || isAreaSelectionInProgress) {
      return;
    }

    this.setTip(highlight.position, content);
  }

  scaledPositionToViewport({
    pageNumber,
    boundingRect,
    rects,
    usePdfCoordinates,
  }: ScaledPosition): Position {
    const viewport = this.viewer.getPageView(pageNumber - 1).viewport;

    return {
      boundingRect: scaledToViewport(boundingRect, viewport, usePdfCoordinates),
      rects: (rects || []).map((rect) =>
        scaledToViewport(rect, viewport, usePdfCoordinates),
      ),
      pageNumber,
    };
  }

  viewportPositionToScaled({
    pageNumber,
    boundingRect,
    rects,
  }: Position): ScaledPosition {
    const viewport = this.viewer.getPageView(pageNumber - 1).viewport;

    return {
      boundingRect: viewportToScaled(boundingRect, viewport),
      rects: (rects || []).map((rect) => viewportToScaled(rect, viewport)),
      pageNumber,
    };
  }

  screenshot(position: LTWH, pageNumber: number) {
    const canvas = this.viewer.getPageView(pageNumber - 1).canvas;

    return getAreaAsPNG(canvas, position);
  }

  hideTipAndSelection = () => {
    this.setState({
      tipPosition: null,
      tipChildren: null,
      ghostHighlight: null,
      tip: null,
    });
    // Don't immediately render - let componentDidUpdate handle it when highlights prop updates
  };

  setTip(position: Position, inner: JSX.Element | null) {
    this.setState({
      tipPosition: position,
      tipChildren: inner,
    });
  }

  renderTip = () => {
    const { tipPosition, tipChildren } = this.state;
    if (!tipPosition) return null;

    const { boundingRect, pageNumber } = tipPosition;
    const page = {
      node: this.viewer.getPageView((boundingRect.pageNumber || pageNumber) - 1)
        .div,
      pageNumber: boundingRect.pageNumber || pageNumber,
    };

    const pageBoundingClientRect = page.node.getBoundingClientRect();

    const pageBoundingRect = {
      bottom: pageBoundingClientRect.bottom,
      height: pageBoundingClientRect.height,
      left: pageBoundingClientRect.left,
      right: pageBoundingClientRect.right,
      top: pageBoundingClientRect.top,
      width: pageBoundingClientRect.width,
      x: pageBoundingClientRect.x,
      y: pageBoundingClientRect.y,
      pageNumber: page.pageNumber,
    };

    return (
      <TipContainer
        scrollTop={this.viewer.container.scrollTop}
        pageBoundingRect={pageBoundingRect}
        style={{
          left:
            page.node.offsetLeft + boundingRect.left + boundingRect.width / 2,
          top: boundingRect.top + page.node.offsetTop,
          bottom: boundingRect.top + page.node.offsetTop + boundingRect.height,
        }}
      >
        {tipChildren}
      </TipContainer>
    );
  };

  onTextLayerRendered = () => {
    this.renderHighlightLayers();
  };

  // Set up paragraph click handler once (called from attachRef)
  setupParagraphClickHandler = () => {
    if (!this.paragraphClickHandlerRef.current) {
      this.paragraphClickHandlerRef.current = (evt: Event) => {
        this.handleParagraphClick(evt as MouseEvent);
      };
    }

    // Attach to container for event delegation
    if (this.containerNode && this.paragraphClickHandlerRef.current) {
      this.containerNode.addEventListener("click", this.paragraphClickHandlerRef.current);
    }
  };

  // Set up viewport observer for performance (called from attachRef)
  setupViewportObserver = () => {
    if (typeof IntersectionObserver === "undefined") return;

    const options = {
      root: this.viewer.container,
      rootMargin: "200px", // 200px buffer for smooth scrolling
    };

    this.viewportObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const pageElement = entry.target as HTMLElement;
        const pageNumber = parseInt(pageElement.dataset.pageNumber || "0");

        if (pageNumber > 0) {
          if (entry.isIntersecting) {
            // Page entered viewport - add to visible set
            this.visiblePageNumbers.add(pageNumber);
            // Render highlights for this page
            this.renderHighlightLayerForPage(pageNumber);
          } else {
            // Page left viewport - remove from visible set and cleanup
            this.visiblePageNumbers.delete(pageNumber);
            this.cleanupHighlightLayerForPage(pageNumber);
          }
        }
      });
    }, options);

    // Observe all page elements
    const pages = this.viewer.container.querySelectorAll(".page");
    pages.forEach((page) => {
      // Ensure page has data-page-number attribute
      if (!(page as HTMLElement).dataset.pageNumber) {
        const pageNumber = Array.from(this.viewer.container.querySelectorAll(".page")).indexOf(page) + 1;
        (page as HTMLElement).dataset.pageNumber = pageNumber.toString();
      }
      this.viewportObserver?.observe(page);
    });
  };

  // Cleanup highlight layer for a specific page when it leaves viewport
  cleanupHighlightLayerForPage(pageNumber: number) {
    const rootData = this.highlightRoots[pageNumber];
    if (rootData && !rootData.container.isConnected) {
      // Already disconnected, clean up
      try {
        rootData.reactRoot.unmount();
      } catch {
        // Ignore errors
      }
      delete this.highlightRoots[pageNumber];
    }
  }

  // Render highlights for a specific page (used by viewport observer)
  renderHighlightLayerForPage(pageNumber: number) {
    // Check if already rendered
    const existingRoot = this.highlightRoots[pageNumber];
    if (existingRoot?.container.isConnected) {
      return; // Already rendered and connected
    }

    // Unmount old root if exists
    if (existingRoot) {
      try {
        existingRoot.reactRoot.unmount();
      } catch {
        // Ignore errors
      }
    }

    // Find or create highlight layer for this page
    const highlightLayer = this.findOrCreateHighlightLayer(pageNumber);
    if (highlightLayer) {
      const reactRoot = createRoot(highlightLayer);
      this.highlightRoots[pageNumber] = {
        reactRoot,
        container: highlightLayer,
      };
      this.renderHighlightLayer(reactRoot, pageNumber);
    }
  }

  handleParagraphClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (!target || !target.closest(".textLayer")) return;

    // Set flag to prevent duplicate handling in onSelectionChange
    this.isHandlingParagraphClick = true;

    // Find the clicked span
    const clickedSpan = target.closest<HTMLElement>("span[role='presentation']");
    if (!clickedSpan) {
      this.isHandlingParagraphClick = false;
      return;
    }

    // Get text layer
    const textLayer = target.closest<HTMLElement>(".textLayer");
    if (!textLayer) {
      this.isHandlingParagraphClick = false;
      return;
    }

    // Use cached spans if available, otherwise build cache
    let cachedSpans = this.spanCache.get(textLayer);
    if (!cachedSpans) {
      cachedSpans = Array.from(
        textLayer.querySelectorAll<HTMLElement>("span[role='presentation']")
      ).map((el) => ({ el, rect: el.getBoundingClientRect() }));
      this.spanCache.set(textLayer, cachedSpans);
    }

    // Find clicked span in cache
    const clickedIndex = cachedSpans.findIndex((s) => s.el === clickedSpan);
    if (clickedIndex === -1) {
      this.isHandlingParagraphClick = false;
      return;
    }

    // Select the full paragraph including wrapped text
    const clickedRect = cachedSpans[clickedIndex].rect;
    const yThreshold = 5; // pixels - spans within this y-distance are considered same line
    const yContinuationThreshold = 18; // pixels - wrapped text continuation (increased for better paragraph detection)
    const xGapThreshold = 30; // pixels - x gaps larger than this indicate different column/section

    // Helper to check if two spans are likely in the same text flow (same column/paragraph)
    const areSpansConnected = (span2Index: number, baseRect: DOMRect): boolean => {
      const rect2 = cachedSpans![span2Index].rect;

      // Check y-position alignment (same or next line for wrapped text)
      const yAligned = Math.abs(rect2.top - baseRect.top) <= yThreshold ||
                      Math.abs(rect2.bottom - baseRect.top) <= yContinuationThreshold ||
                      Math.abs(rect2.top - baseRect.bottom) <= yContinuationThreshold;

      if (!yAligned) return false;

      // Check x-position (no large gaps that would indicate different column)
      // Spans should overlap horizontally or be close
      const horizontalOverlap = !(rect2.right < baseRect.left - xGapThreshold ||
                                 rect2.left > baseRect.right + xGapThreshold);

      return horizontalOverlap;
    };

    // Find the first span of the paragraph by going backward
    let startIndex = clickedIndex;
    let currentRect = clickedRect;
    while (startIndex > 0) {
      if (!areSpansConnected(startIndex - 1, currentRect)) {
        break;
      }
      startIndex--;
      currentRect = cachedSpans[startIndex].rect;
    }

    // Find the last span of the paragraph by going forward
    let endIndex = clickedIndex;
    currentRect = clickedRect;
    while (endIndex < cachedSpans.length - 1) {
      if (!areSpansConnected(endIndex + 1, currentRect)) {
        break;
      }
      endIndex++;
      currentRect = cachedSpans[endIndex].rect;
    }

    // Create range from first to last span of the paragraph
    const range = document.createRange();
    range.setStartBefore(cachedSpans[startIndex].el);
    range.setEndAfter(cachedSpans[endIndex].el);

    // Select the range
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // Store the range and trigger tip
    this.setState(
      {
        isCollapsed: false,
        range,
      },
      () => {
        this.afterSelection();
        // Clear flag after processing
        this.isHandlingParagraphClick = false;
      }
    );

    event.preventDefault();
    event.stopPropagation();
  };

  scrollTo = (highlight: T_HT) => {
    const { pageNumber, boundingRect, usePdfCoordinates } = highlight.position;

    this.viewer.container.removeEventListener("scroll", this.onScroll);

    const pageViewport = this.viewer.getPageView(pageNumber - 1).viewport;

    const scrollMargin = 10;

    this.viewer.scrollPageIntoView({
      pageNumber,
      destArray: [
        null,
        { name: "XYZ" },
        ...pageViewport.convertToPdfPoint(
          0,
          scaledToViewport(boundingRect, pageViewport, usePdfCoordinates).top -
            scrollMargin,
        ),
        0,
      ],
    });

    this.setState(
      {
        scrolledToHighlightId: highlight.id,
      },
      () => this.renderHighlightLayers(),
    );

    // wait for scrolling to finish
    this.scrollTimeoutId = setTimeout(() => {
      this.viewer.container.addEventListener("scroll", this.onScroll);
      this.scrollTimeoutId = null;
    }, 100);
  };

  onDocumentReady = () => {
    const { scrollRef } = this.props;

    this.handleScaleValue();

    scrollRef?.(this.scrollTo);
  };

  onSelectionChange = () => {
    // Skip if we're handling a paragraph click (to avoid duplicate handling)
    if (this.isHandlingParagraphClick) {
      return;
    }

    const container = this.containerNode;
    if (!container) {
      return;
    }

    const selection = getWindow(container).getSelection();
    if (!selection) {
      return;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (selection.isCollapsed) {
      this.setState({ isCollapsed: true });
      return;
    }

    if (
      !range ||
      !container ||
      !container.contains(range.commonAncestorContainer)
    ) {
      return;
    }

    this.setState({
      isCollapsed: false,
      range,
    });

    this.debouncedAfterSelection();
  };

  onScroll = () => {
    const { onScrollChange } = this.props;

    onScrollChange();

    this.setState(
      {
        scrolledToHighlightId: EMPTY_ID,
      },
      () => this.renderHighlightLayers(),
    );

    this.viewer.container.removeEventListener("scroll", this.onScroll);
  };

  onMouseDown: PointerEventHandler = (event) => {
    if (!(event.target instanceof Element) || !isHTMLElement(event.target)) {
      return;
    }

    if (event.target.closest("#PdfHighlighter__tip-container")) {
      return;
    }

    this.hideTipAndSelection();
  };

  handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") {
      this.hideTipAndSelection();
    }
  };

  afterSelection = () => {
    const { onSelectionFinished } = this.props;

    const { isCollapsed, range } = this.state;

    if (!range || isCollapsed) {
      return;
    }

    const pages = getPagesFromRange(range);

    if (!pages || pages.length === 0) {
      return;
    }

    const rects = getClientRects(range, pages);

    if (rects.length === 0) {
      return;
    }

    const boundingRect = getBoundingRect(rects);

    const viewportPosition: Position = {
      boundingRect,
      rects,
      pageNumber: pages[0].number,
    };

    const content = {
      text: range.toString(),
    };
    const scaledPosition = this.viewportPositionToScaled(viewportPosition);

    this.setTip(
      viewportPosition,
      onSelectionFinished(
        scaledPosition,
        content,
        () => this.hideTipAndSelection(),
        () =>
          this.setState(
            {
              ghostHighlight: { position: scaledPosition },
            },
            () => this.renderHighlightLayers(),
          ),
      ),
    );
  };

  debouncedAfterSelection: () => void = debounce(this.afterSelection, 500);

  toggleTextSelection(flag: boolean) {
    if (!this.viewer.viewer) {
      return;
    }
    this.viewer.viewer.classList.toggle(styles.disableSelection, flag);
  }

  handleScaleValue = () => {
    if (this.viewer) {
      this.viewer.currentScaleValue = this.props.pdfScaleValue; //"page-width";
    }
  };

  debouncedScaleValue: () => void = debounce(this.handleScaleValue, 500);

  render() {
    const { onSelectionFinished, enableAreaSelection } = this.props;

    return (
      <div onPointerDown={this.onMouseDown}>
        <div
          ref={this.containerNodeRef}
          className={styles.container}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="pdfViewer" />
          {this.renderTip()}
          {typeof enableAreaSelection === "function" ? (
            <MouseSelection
              onDragStart={() => this.toggleTextSelection(true)}
              onDragEnd={() => this.toggleTextSelection(false)}
              onChange={(isVisible) =>
                this.setState({ isAreaSelectionInProgress: isVisible })
              }
              shouldStart={(event) =>
                enableAreaSelection(event) &&
                event.target instanceof Element &&
                isHTMLElement(event.target) &&
                Boolean(event.target.closest(".page"))
              }
              onSelection={(startTarget, boundingRect, resetSelection) => {
                const page = getPageFromElement(startTarget);

                if (!page) {
                  return;
                }

                const pageBoundingRect = {
                  ...boundingRect,
                  top: boundingRect.top - page.node.offsetTop,
                  left: boundingRect.left - page.node.offsetLeft,
                  pageNumber: page.number,
                };

                const viewportPosition = {
                  boundingRect: pageBoundingRect,
                  rects: [],
                  pageNumber: page.number,
                };

                const scaledPosition =
                  this.viewportPositionToScaled(viewportPosition);

                const image = this.screenshot(
                  pageBoundingRect,
                  pageBoundingRect.pageNumber,
                );

                this.setTip(
                  viewportPosition,
                  onSelectionFinished(
                    scaledPosition,
                    { image },
                    () => this.hideTipAndSelection(),
                    () => {
                      console.log("setting ghost highlight", scaledPosition);
                      this.setState(
                        {
                          ghostHighlight: {
                            position: scaledPosition,
                            content: { image },
                          },
                        },
                        () => {
                          resetSelection();
                          this.renderHighlightLayers();
                        },
                      );
                    },
                  ),
                );
              }}
            />
          ) : null}
        </div>
      </div>
    );
  }

  private renderHighlightLayers() {
    const { pdfDocument } = this.props;

    // If viewport observer is active and we have visible pages, only render those
    // Otherwise fall back to rendering all pages (initial render or no IntersectionObserver support)
    const pagesToRender =
      this.viewportObserver && this.visiblePageNumbers.size > 0
        ? this.visiblePageNumbers
        : new Set(Array.from({ length: pdfDocument.numPages }, (_, i) => i + 1));

    // Also ensure first page is always rendered initially
    if (pagesToRender.size === 0) {
      pagesToRender.add(1);
    }

    // Clean up highlight roots for pages that are no longer visible
    for (const pageNumber in this.highlightRoots) {
      const pageNum = parseInt(pageNumber);
      if (!pagesToRender.has(pageNum)) {
        // Page is no longer visible, clean it up
        const rootData = this.highlightRoots[pageNumber];
        if (rootData && !rootData.container.isConnected) {
          try {
            rootData.reactRoot.unmount();
          } catch {
            // Ignore errors during unmount
          }
          delete this.highlightRoots[pageNumber];
        }
      }
    }

    // Render highlights for visible pages
    for (const pageNumber of pagesToRender) {
      const highlightRoot = this.highlightRoots[pageNumber];
      /** Need to check if container is still attached to the DOM as PDF.js can unload pages. */
      if (highlightRoot?.container.isConnected) {
        this.renderHighlightLayer(highlightRoot.reactRoot, pageNumber);
      } else {
        // Unmount old root if exists to prevent memory leak
        if (highlightRoot) {
          try {
            highlightRoot.reactRoot.unmount();
          } catch {
            // Ignore errors during unmount
          }
        }
        const highlightLayer = this.findOrCreateHighlightLayer(pageNumber);
        if (highlightLayer) {
          const reactRoot = createRoot(highlightLayer);
          this.highlightRoots[pageNumber] = {
            reactRoot,
            container: highlightLayer,
          };
          this.renderHighlightLayer(reactRoot, pageNumber);
        }
      }
    }
  }

  private renderHighlightLayer(root: Root, pageNumber: number) {
    const { highlightTransform, highlights } = this.props;
    const { tip, scrolledToHighlightId } = this.state;
    root.render(
      <HighlightLayer
        highlightsByPage={this.groupHighlightsByPage(highlights)}
        pageNumber={pageNumber.toString()}
        scrolledToHighlightId={scrolledToHighlightId}
        highlightTransform={highlightTransform}
        tip={tip}
        scaledPositionToViewport={this.scaledPositionToViewport.bind(this)}
        hideTipAndSelection={this.hideTipAndSelection.bind(this)}
        viewer={this.viewer}
        screenshot={this.screenshot.bind(this)}
        showTip={this.showTip.bind(this)}
        setTip={(tip) => {
          this.setState({ tip });
        }}
      />,
    );
  }

  /**
   * Public API: Find similar sections across the PDF document
   * This method can be called by parent components to trigger similarity search
   */
  async findSimilarSections(options: Omit<SimilaritySearchOptions, "pdfDocument" | "viewer">): Promise<SimilarityResult[]> {
    return findSimilarSections({
      ...options,
      pdfDocument: this.props.pdfDocument,
      viewer: this.viewer,
    });
  }

  /**
   * Get the PDF viewer instance for external use
   */
  getViewer(): PDFViewer {
    return this.viewer;
  }

  /**
   * Get the PDF document instance for external use
   */
  getPdfDocument(): PDFDocumentProxy {
    return this.props.pdfDocument;
  }
}
