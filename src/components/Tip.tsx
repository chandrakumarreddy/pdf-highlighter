import { useEffect, useState } from "react";
import styles from "../style/Tip.module.css";

const EMOJI_OPTIONS = ["Section", "Subsection", "Question"] as const;

interface Props {
  onConfirm: (comment: { text: string; emoji: string }) => void;
  onUpdate?: () => void;
}

export function Tip({ onConfirm, onUpdate }: Props) {
  const [emoji, setEmoji] = useState("");

  useEffect(() => {
    if (onUpdate) {
      onUpdate();
    }
  }, [onUpdate]);

  return (
    <form
      className={styles.card}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm({ text: "", emoji });
      }}
    >
      <div>
        <div>
          {EMOJI_OPTIONS.map((_emoji) => (
            <label
              key={_emoji}
              style={{
                color: "#000",
                fontSize: 12,
              }}
            >
              <input
                type="radio"
                name="emoji"
                value={_emoji}
                checked={emoji === _emoji}
                onChange={(e) => setEmoji(e.target.value)}
              />
              {_emoji}
            </label>
          ))}
        </div>
      </div>
      <div>
        <input type="submit" value="Save" />
      </div>
    </form>
  );
}
