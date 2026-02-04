import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const DEFAULT_WORKER_SRC =
  "https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";

interface Props {
  /** See `GlobalWorkerOptionsType`. */
  workerSrc?: string;

  url: string;
  beforeLoad: React.ReactElement;
  errorMessage?: React.ReactElement;
  children: (pdfDocument: PDFDocumentProxy) => React.ReactElement;
  onError?: (error: Error) => void;
  cMapUrl?: string;
  cMapPacked?: boolean;
}

export const PdfLoader: React.FC<Props> = ({
  workerSrc = DEFAULT_WORKER_SRC,
  url,
  beforeLoad,
  errorMessage,
  children,
  onError,
  cMapUrl,
  cMapPacked,
}) => {
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const documentRef = useRef<HTMLElement>(null);
  const discardedDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const prevUrlRef = useRef<string | undefined>(undefined);

  const handleError = useCallback(
    (err: Error) => {
      onError?.(err);
      setPdfDocument(null);
      setError(err);
    },
    [onError],
  );

  useEffect(() => {
    // Skip if url hasn't changed (not on first render)
    if (prevUrlRef.current === url) {
      return;
    }

    // Update previous url ref
    prevUrlRef.current = url;

    const { ownerDocument = document } = documentRef.current || {};

    setPdfDocument(null);
    setError(null);

    if (typeof workerSrc === "string") {
      GlobalWorkerOptions.workerSrc = workerSrc;
    }

    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return;
        const discarded = discardedDocumentRef.current;
        discardedDocumentRef.current = null;
        return discarded?.destroy();
      })
      .then(() => {
        if (cancelled || !url) {
          return;
        }

        const documentParams = {
          url,
          ownerDocument,
          cMapUrl,
          cMapPacked,
        };

        return getDocument(documentParams).promise.then((doc) => {
          if (cancelled) return;
          discardedDocumentRef.current = doc;
          setPdfDocument(doc);
        });
      })
      .catch((e) => {
        if (!cancelled) handleError(e);
      });

    // Cleanup: destroy PDF document on unmount or url change
    return () => {
      cancelled = true;
      const discarded = discardedDocumentRef.current;
      if (discarded) {
        discarded.destroy();
        discardedDocumentRef.current = null;
      }
    };
  }, [url, workerSrc, cMapUrl, cMapPacked, handleError]);

  // Memoize error rendering
  const renderError = useMemo(() => {
    if (errorMessage && error) {
      return React.cloneElement(
        errorMessage as React.ReactElement<{ error?: Error }>,
        {
          error,
        },
      );
    }
    return null;
  }, [errorMessage, error]);

  return (
    <>
      <span ref={documentRef} />
      {error
        ? renderError
        : !pdfDocument || !children
          ? beforeLoad
          : children(pdfDocument)}
    </>
  );
};
