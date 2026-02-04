import React, { useState, useRef } from "react";

import {
  AreaHighlight,
  Highlight,
  PdfHighlighter,
  PdfLoader,
  Popup,
  Tip,
} from "./react-pdf-highlighter";
import type {
  Content,
  IHighlight,
  NewHighlight,
  ScaledPosition,
} from "./react-pdf-highlighter";

import { Sidebar } from "./Sidebar";
import { Spinner } from "./Spinner";

import "./style/App.css";
import "../../dist/style.css";

const testHighlights: Record<string, Array<IHighlight>> = {};

const getNextId = () => String(Math.random()).slice(2);

// Similarity search threshold (0.8 = 80% similarity)
const SIMILARITY_THRESHOLD = 0.8;

const parseIdFromHash = () =>
  document.location.hash.slice("#highlight-".length);

const resetHash = () => {
  document.location.hash = "";
};

const HighlightPopup = ({
  comment,
}: {
  comment: { text: string; emoji: string };
}) =>
  comment.text ? (
    <div className="Highlight__popup">
      {comment.emoji} {comment.text}
    </div>
  ) : null;

const PRIMARY_PDF_URL = import.meta.env.BASE_URL + "test.pdf";

const SECONDARY_PDF_URL = "https://arxiv.org/pdf/1604.02480";

export function App() {
  const searchParams = new URLSearchParams(document.location.search);
  const initialUrl = searchParams.get("url") || PRIMARY_PDF_URL;

  const [url, setUrl] = useState(initialUrl);
  const [highlights, setHighlights] = useState<Array<IHighlight>>(
    testHighlights[initialUrl] ? [...testHighlights[initialUrl]] : [],
  );
  const [isSearchingSimilar, setIsSearchingSimilar] = useState(false);

  // Ref to access PdfHighlighter methods
  const pdfHighlighterRef = useRef<any>(null);

  const resetHighlights = () => {
    setHighlights([]);
  };

  const toggleDocument = () => {
    const newUrl =
      url === PRIMARY_PDF_URL ? SECONDARY_PDF_URL : PRIMARY_PDF_URL;
    setUrl(newUrl);
    setHighlights(testHighlights[newUrl] ? [...testHighlights[newUrl]] : []);
  };

  const scrollViewerTo = useRef((highlight: IHighlight) => {});

  const addHighlight = (highlight: NewHighlight) => {
    console.log("Saving highlight", highlight);
    setHighlights((prevHighlights) => [
      { ...highlight, id: getNextId() },
      ...prevHighlights,
    ]);
  };

  // Add multiple highlights at once (for similar sections)
  const addHighlights = (newHighlights: NewHighlight[]) => {
    setHighlights((prevHighlights) => [
      ...newHighlights.map((h) => ({ ...h, id: getNextId() })),
      ...prevHighlights,
    ]);
  };

  // Find and add similar sections when a highlight is created
  const handleHighlightWithSimilarity = async (
    highlight: NewHighlight,
    hideTipAndSelection: () => void,
  ) => {
    const { content, position, comment } = highlight;

    // Only search for similar sections if it's a text highlight (not image)
    if (!content.text || content.text.length < 15) {
      // Text too short, just add the single highlight
      addHighlight(highlight);
      hideTipAndSelection();
      return;
    }

    // Add the original highlight first
    addHighlight(highlight);
    hideTipAndSelection();

    // Search for similar sections
    if (pdfHighlighterRef.current) {
      setIsSearchingSimilar(true);
      try {
        const similarSections = await pdfHighlighterRef.current.findSimilarSections({
          selectedText: content.text,
          selectedPosition: position,
          threshold: SIMILARITY_THRESHOLD,
          maxResults: 20,
          onProgress: (current: number, total: number, found: number) => {
            console.log(`Searching similar sections: page ${current}/${total}, found ${found}`);
          },
        });

        // Create highlights for all similar sections
        const similarHighlights: NewHighlight[] = similarSections.map((result: any) => ({
          content: { text: result.text },
          position: result.position,
          comment: {
            ...comment,
            text: `Similar (${Math.round(result.score * 100)}%)`,
          },
        }));

        if (similarHighlights.length > 0) {
          addHighlights(similarHighlights);
          console.log(`Added ${similarHighlights.length} similar highlights`);
        }
      } catch (error) {
        console.error("Error finding similar sections:", error);
      } finally {
        setIsSearchingSimilar(false);
      }
    }
  };

  const updateHighlight = (
    highlightId: string,
    position: Partial<ScaledPosition>,
    content: Partial<Content>,
  ) => {
    console.log("Updating highlight", highlightId, position, content);
    setHighlights((prevHighlights) =>
      prevHighlights.map((h) => {
        const {
          id,
          position: originalPosition,
          content: originalContent,
          ...rest
        } = h;
        return id === highlightId
          ? {
              id,
              position: { ...originalPosition, ...position },
              content: { ...originalContent, ...content },
              ...rest,
            }
          : h;
      }),
    );
  };

  return (
    <div
      className="App"
      style={{ display: "flex", height: "100vh", width: "100vw" }}
    >
      <div
        style={{
          flex: 1,
          border: "2px solid #fff",
          margin: "32px auto",
          overflow: "hidden",
          borderRadius: 16,
          padding: 8,
          maxWidth: 1000,
        }}
      >
        <div
          style={{
            height: "100vh",
            flex: 1,
            minWidth: 0,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <PdfLoader url={url} beforeLoad={<Spinner />}>
            {(pdfDocument) => (
              <PdfHighlighter
                ref={pdfHighlighterRef as any}
                pdfDocument={pdfDocument}
                enableAreaSelection={(event) => event.altKey}
                onScrollChange={resetHash}
                scrollRef={(scrollTo) => {
                  scrollViewerTo.current = scrollTo;
                }}
                onSelectionFinished={(
                  position,
                  content,
                  hideTipAndSelection,
                ) => (
                  <Tip
                    onConfirm={(comment) => {
                      handleHighlightWithSimilarity(
                        { content, position, comment },
                        hideTipAndSelection,
                      );
                    }}
                  />
                )}
                highlightTransform={(
                  highlight,
                  index,
                  setTip,
                  hideTip,
                  viewportToScaled,
                  screenshot,
                  isScrolledTo,
                ) => {
                  const isTextHighlight = !highlight.content?.image;

                  const component = isTextHighlight ? (
                    <Highlight
                      isScrolledTo={isScrolledTo}
                      position={highlight.position}
                      comment={highlight.comment}
                    />
                  ) : (
                    <AreaHighlight
                      isScrolledTo={isScrolledTo}
                      highlight={highlight}
                      onChange={(boundingRect) => {
                        updateHighlight(
                          highlight.id,
                          { boundingRect: viewportToScaled(boundingRect) },
                          { image: screenshot(boundingRect) },
                        );
                      }}
                    />
                  );

                  return (
                    <Popup
                      popupContent={<HighlightPopup {...highlight} />}
                      onMouseOver={(popupContent) =>
                        setTip(highlight, (highlight) => popupContent)
                      }
                      onMouseOut={hideTip}
                      key={index}
                    >
                      {component}
                    </Popup>
                  );
                }}
                highlights={highlights}
              />
            )}
          </PdfLoader>
          {isSearchingSimilar && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(255, 255, 255, 0.8)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
            >
              <div style={{ textAlign: "center" }}>
                <Spinner />
                <p style={{ marginTop: 16, fontSize: 14, color: "#666" }}>
                  Finding similar sections...
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* <Sidebar
        highlights={highlights}
        resetHighlights={resetHighlights}
        toggleDocument={toggleDocument}
      /> */}
    </div>
  );
}
