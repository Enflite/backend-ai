import type { AssistantState } from '../activity';

interface AssistantAvatarProps {
  state: AssistantState;
  /** Pixels; defaults to 32 to match the message-list avatar. */
  size?: number;
  onClick?: () => void;
  /** Accessible label for the button. */
  label?: string;
}

const STATE_CLASS: Record<AssistantState, string> = {
  idle: 'enflite-avatar--idle',
  thinking: 'enflite-avatar--thinking',
  streaming: 'enflite-avatar--streaming',
  tools: 'enflite-avatar--tools',
};

const STATE_LABEL: Record<AssistantState, string> = {
  idle: 'Enflite assistant — idle',
  thinking: 'Enflite assistant — thinking',
  streaming: 'Enflite assistant — replying',
  tools: 'Enflite assistant — working',
};

/**
 * The Enflite AI mascot, alive. Pure CSS animations (see index.css) driven
 * by chat state — no JS animation loops, no extra dependencies:
 *  - idle:      gentle float, at rest
 *  - thinking:  soft breathing glow while waiting for the first token
 *  - streaming: lively pulse while tokens arrive ("talking")
 *  - tools:     orbiting ring while tool calls run ("busy")
 *
 * Clicking opens the activity panel.
 */
export default function AssistantAvatar({ state, size = 32, onClick, label }: AssistantAvatarProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? STATE_LABEL[state]}
      title="View activity"
      className={`enflite-avatar ${STATE_CLASS[state]}`}
      style={{ width: size, height: size }}
    >
      <span className="enflite-avatar__ring" aria-hidden="true" />
      <img
        src="/enflite-assistant.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="enflite-avatar__img"
      />
    </button>
  );
}
