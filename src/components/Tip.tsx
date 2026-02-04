import { useEffect, useState } from "react";
import styles from "../style/Tip.module.css";

const EMOJI_OPTIONS = ["Section", "Subsection", "Question"] as const;

interface Props {
  onConfirm: (comment: { text: string; emoji: string }) => void;
  onUpdate?: () => void;
  initialEmoji?: string; // For edit mode - pre-select the current emoji
  onDelete?: () => void; // For delete option in edit mode
}

export function Tip({ onConfirm, onUpdate, initialEmoji, onDelete }: Props) {
  const [emoji, setEmoji] = useState(initialEmoji || "");

  useEffect(() => {
    if (onUpdate) {
      onUpdate();
    }
  }, [onUpdate]);

  const handleEmojiChange = (value: string) => {
    setEmoji(value);
    onConfirm({ text: "", emoji: value });
  };

  return (
    <div className={styles.card}>
      <div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
          {EMOJI_OPTIONS.map((_emoji) => (
            <label key={_emoji}>
              <input
                type="radio"
                name="emoji"
                value={_emoji}
                checked={emoji === _emoji}
                onChange={(e) => handleEmojiChange(e.target.value)}
              />
              {_emoji}
            </label>
          ))}
        </div>
        {initialEmoji && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            style={{
              marginTop: "8px",
              padding: "4px 8px",
              background: "#ff4444",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
