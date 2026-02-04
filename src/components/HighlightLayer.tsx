import { useEffect, useRef } from "react";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { viewportToScaled } from "../lib/coordinates";
import type {
  IHighlight,
  LTWH,
  LTWHP,
  Position,
  Scaled,
  ScaledPosition,
} from "../types";
import type { T_ViewportHighlight } from "./PdfHighlighter";

interface HighlightLayerProps<T_HT> {
  highlightsByPage: { [pageNumber: string]: Array<T_HT> };
  pageNumber: string;
  scrolledToHighlightId: string;
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
  tip: {
    highlight: T_ViewportHighlight<T_HT>;
    callback: (highlight: T_ViewportHighlight<T_HT>) => JSX.Element;
  } | null;
  scaledPositionToViewport: (scaledPosition: ScaledPosition) => Position;
  hideTipAndSelection: () => void;
  viewer: PDFViewer;
  screenshot: (position: LTWH, pageNumber: number) => string;
  showTip: (highlight: T_ViewportHighlight<T_HT>, content: JSX.Element) => void;
  setTip: (state: {
    highlight: T_ViewportHighlight<T_HT>;
    callback: (highlight: T_ViewportHighlight<T_HT>) => JSX.Element;
  }) => void;
}

export function HighlightLayer<T_HT extends IHighlight>({
  highlightsByPage,
  scaledPositionToViewport,
  pageNumber,
  scrolledToHighlightId,
  highlightTransform,
  tip,
  hideTipAndSelection,
  viewer,
  screenshot,
  showTip,
  setTip,
}: HighlightLayerProps<T_HT>) {
  const currentHighlights = highlightsByPage[String(pageNumber)] || [];
  const tipShownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Defer showing tip until after render to avoid side-effect during render
    if (tip) {
      const highlightId = String(tip.highlight.id);
      if (!tipShownRef.current.has(highlightId)) {
        const highlight = currentHighlights.find((h) => String(h.id) === highlightId);
        if (highlight) {
          const viewportHighlight: T_ViewportHighlight<T_HT> = {
            ...highlight,
            position: scaledPositionToViewport(highlight.position),
          };
          tipShownRef.current.add(highlightId);
          showTip(tip.highlight, tip.callback(viewportHighlight));
        }
      }
    }
    // Reset tip shown tracking when tip changes to null
    if (!tip) {
      tipShownRef.current.clear();
    }
  }, [tip, currentHighlights, scaledPositionToViewport, showTip]);

  return (
    <div>
      {currentHighlights.map((highlight, index) => {
        const viewportHighlight: T_ViewportHighlight<T_HT> = {
          ...highlight,
          position: scaledPositionToViewport(highlight.position),
        };

        const isScrolledTo = Boolean(scrolledToHighlightId === highlight.id);

        return highlightTransform(
          viewportHighlight,
          index,
          (highlight, callback) => {
            setTip({ highlight, callback });
            showTip(highlight, callback(highlight));
          },
          hideTipAndSelection,
          (rect) => {
            const viewport = viewer.getPageView(
              (rect.pageNumber || Number.parseInt(pageNumber)) - 1,
            ).viewport;

            return viewportToScaled(rect, viewport);
          },
          (boundingRect) =>
            screenshot(boundingRect, Number.parseInt(pageNumber)),
          isScrolledTo,
        );
      })}
    </div>
  );
}
