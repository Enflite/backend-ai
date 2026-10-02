export default function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="animate-spin"
      aria-label="Loading"
    >
      <path d="M8 1.5a6.5 6.5 0 016.5 6.5" />
    </svg>
  );
}
