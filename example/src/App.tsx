import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api.js";

type Sandbox = NonNullable<
  NonNullable<FunctionReturnType<typeof api.demoQueries.mine>>["main"]
>;
type Key = "main" | "fork";
type Entry = {
  id: number;
  command: string;
  output?: string;
  exitCode?: number;
  error?: string;
};

export default function App() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) void signIn("anonymous");
  }, [isLoading, isAuthenticated, signIn]);

  return (
    <main>
      <header>
        <h1>
          Tenki Sandboxes <span className="x">×</span> Convex
        </h1>
        <p>
          Each visitor gets a cloud microVM. Its state lives in a Convex table,
          so everything below updates live as it changes.
        </p>
      </header>
      {isAuthenticated ? <Demo /> : <p className="muted">Signing you in…</p>}
      <footer>
        Built with <code>@tenkicloud/convex</code>. Sandboxes in this demo last
        10 minutes.
      </footer>
    </main>
  );
}

function Demo() {
  const sandboxes = useQuery(api.demoQueries.mine);
  const create = useAction(api.demo.create);
  const fork = useAction(api.demo.fork);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (sandboxes === undefined) return <p className="muted">Loading…</p>;
  const main = sandboxes?.main;
  const live = main && main.phase !== "terminated" && main.phase !== "error";

  const attempt = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <p className="error">{error}</p>}
      {!live ? (
        <section className="card empty">
          {main?.lastError && (
            <p className="error">
              Last attempt failed: {main.lastError.message}
            </p>
          )}
          <button
            className="primary"
            disabled={busy || main?.phase === "provisioning"}
            onClick={() => attempt(create)}
          >
            {main?.phase === "provisioning" ? "Starting…" : "Start a sandbox"}
          </button>
        </section>
      ) : (
        <>
          <SandboxPanel sandbox={main} title="Your sandbox" />
          {sandboxes?.fork && sandboxes.fork.phase !== "terminated" ? (
            <SandboxPanel sandbox={sandboxes.fork} title="Fork" />
          ) : (
            main.phase === "ready" && (
              <section className="card empty">
                <p className="muted">
                  Snapshot your sandbox and boot an independent copy of it,
                  files and all.
                </p>
                <button disabled={busy} onClick={() => attempt(fork)}>
                  {busy ? "Forking…" : "Fork it"}
                </button>
              </section>
            )
          )}
        </>
      )}
    </>
  );
}

function SandboxPanel({ sandbox, title }: { sandbox: Sandbox; title: string }) {
  const key = sandbox.key as Key;
  const pause = useAction(api.demo.pause);
  const resume = useAction(api.demo.resume);
  const refresh = useAction(api.demo.refresh);
  const destroy = useAction(api.demo.destroy);
  const startWebServer = useAction(api.demo.startWebServer);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(undefined);
    }
  };

  // A pause started without waiting settles in the background; poll until it does.
  useEffect(() => {
    if (sandbox.phase !== "pausing") return;
    const timer = setInterval(
      () => void refresh({ key }).catch(() => {}),
      5_000,
    );
    return () => clearInterval(timer);
  }, [sandbox.phase, key, refresh]);

  const ready = sandbox.phase === "ready";
  return (
    <section className="card">
      <div className="row">
        <h2>{title}</h2>
        <Phase phase={sandbox.phase} />
        <Countdown until={sandbox.remote?.timeoutAt} />
      </div>
      <p className="muted mono">
        {sandbox.sessionId} · {sandbox.remote?.cpuCores} vCPU ·{" "}
        {sandbox.remote?.memoryMb} MB
      </p>
      <div className="actions">
        {ready && (
          <button
            disabled={!!busy}
            onClick={() => attempt("web", () => startWebServer({ key }))}
          >
            {busy === "web" ? "Starting server…" : "Start a web server"}
          </button>
        )}
        {ready && (
          <button
            disabled={!!busy}
            onClick={() => attempt("pause", () => pause({ key }))}
          >
            Pause
          </button>
        )}
        {sandbox.phase === "paused" && (
          <button
            disabled={!!busy}
            onClick={() => attempt("resume", () => resume({ key }))}
          >
            {busy === "resume" ? "Resuming…" : "Resume"}
          </button>
        )}
        <button
          className="danger"
          disabled={!!busy}
          onClick={() => attempt("destroy", () => destroy({ key }))}
        >
          Destroy
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {sandbox.previews?.map((p) => (
        <p key={p.port} className="preview">
          Port {p.port} is live at{" "}
          <a href={p.url} target="_blank" rel="noreferrer">
            {p.url}
          </a>
        </p>
      ))}
      {ready && <Terminal sandboxKey={key} />}
    </section>
  );
}

function Terminal({ sandboxKey }: { sandboxKey: Key }) {
  const run = useAction(api.demo.run);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [command, setCommand] = useState("uname -a && python3 --version");
  const [running, setRunning] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [entries]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!command.trim() || running) return;
    const id = Date.now();
    setEntries((prev) => [...prev, { id, command }]);
    setRunning(true);
    try {
      const r = await run({ key: sandboxKey, command });
      const output =
        r.stdout +
        r.stderr +
        (r.stdoutTruncated || r.stderrTruncated ? "\n[output truncated]" : "");
      setEntries((prev) =>
        prev.map((x) =>
          x.id === id ? { ...x, output, exitCode: r.exitCode } : x,
        ),
      );
    } catch (err) {
      setEntries((prev) =>
        prev.map((x) => (x.id === id ? { ...x, error: messageOf(err) } : x)),
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="terminal">
      <div className="log">
        {entries.length === 0 && (
          <p className="muted">Run any shell command in the sandbox.</p>
        )}
        {entries.map((x) => (
          <div key={x.id}>
            <div className="cmd">$ {x.command}</div>
            {x.output !== undefined && <pre>{x.output || " "}</pre>}
            {x.exitCode !== undefined && x.exitCode !== 0 && (
              <div className="exit">exit {x.exitCode}</div>
            )}
            {x.error && <div className="exit">{x.error}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={submit}>
        <span className="prompt">$</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          spellCheck={false}
          aria-label="Command"
        />
        <button disabled={running}>{running ? "Running…" : "Run"}</button>
      </form>
    </div>
  );
}

function Phase({ phase }: { phase: Sandbox["phase"] }) {
  return <span className={`phase phase-${phase}`}>{phase}</span>;
}

function Countdown({ until }: { until?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (!until) return null;
  const left = Math.max(0, Math.round((until - now) / 1000));
  return (
    <span className="muted countdown">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
    </span>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof ConvexError)
    return (err.data as { message?: string })?.message ?? String(err.data);
  return err instanceof Error ? err.message : String(err);
}
