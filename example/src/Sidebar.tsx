import type { IHighlight } from "./react-pdf-highlighter";

interface Props {
  highlights: Array<IHighlight>;
  resetHighlights: () => void;
  toggleDocument: () => void;
}

const updateHash = (highlight: IHighlight) => {
  document.location.hash = `highlight-${highlight.id}`;
};

export function Sidebar({
  highlights,
  toggleDocument,
  resetHighlights,
}: Props) {
  const highlightCount = highlights.length;

  return (
    <div className="sidebar">
      {/* Header */}
      <div className="sidebar__header">
        <h1 className="sidebar__title">
          Highlights
          {highlightCount > 0 && (
            <span className="sidebar__count-badge">{highlightCount}</span>
          )}
        </h1>
      </div>

      {/* Highlights Section */}
      <div className="sidebar__section">
        <div className="sidebar__section-label">Annotations</div>

        {highlightCount === 0 ? (
          <div className="sidebar__empty">
            No highlights yet. Select text in the PDF to create annotations.
          </div>
        ) : (
          <ul className="sidebar__highlights">
            {highlights.map((highlight, index) => (
              <li
                key={index}
                className="sidebar__highlight"
                onClick={() => {
                  updateHash(highlight);
                }}
              >
                <div className="highlight__comment">
                  {highlight.comment?.text || "Untitled annotation"}
                </div>
                {highlight.content?.text ? (
                  <blockquote>
                    {`${highlight.content.text.slice(0, 90).trim()}…`}
                  </blockquote>
                ) : null}
                {highlight.content?.image ? (
                  <div className="highlight__image">
                    <img src={highlight.content.image} alt="Screenshot" />
                  </div>
                ) : null}
                {highlight.position && (
                  <div className="highlight__location">
                    Page {highlight.position.pageNumber}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Actions Section */}
      <div className="sidebar__actions">
        <button type="button" onClick={toggleDocument}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
          Toggle PDF document
        </button>
        {highlightCount > 0 && (
          <button type="button" onClick={resetHighlights}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <path d="M3 3v5h5"></path>
            </svg>
            Reset highlights
          </button>
        )}
      </div>
    </div>
  );
}
