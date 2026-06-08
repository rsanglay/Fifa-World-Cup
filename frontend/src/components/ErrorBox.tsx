export default function ErrorBox({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card flex flex-col items-center gap-3 p-8 text-center">
      <div className="text-4xl">📡</div>
      <div className="font-semibold">Couldn't reach the server</div>
      <p className="max-w-sm text-sm text-white/50">
        {message || "The prediction API isn't responding. Make sure the backend is running on port 8090."}
      </p>
      {onRetry && (
        <button onClick={onRetry} className="btn-primary mt-1 text-sm">
          Try again
        </button>
      )}
    </div>
  );
}
