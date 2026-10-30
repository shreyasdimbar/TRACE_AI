"""
chroma_server.py — launch the local Chroma server.

chromadb 1.5.x registers no console script, so `chroma run` is not on PATH. The
CLI is a Rust binding reached through chromadb.cli.cli.app(), which reads
sys.argv. Passing that code inline on a command line means fighting shell
quoting, so it lives in a file instead.

    python scripts/chroma_server.py [--path DIR] [--host HOST] [--port N]
"""

import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a local Chroma server.")
    parser.add_argument("--path", default=os.path.join(os.getcwd(), "chroma_server"),
                        help="persistence directory (default: ./chroma_server)")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--logfile", default=None,
                        help="also write stdout/stderr here")
    args = parser.parse_args()

    os.makedirs(args.path, exist_ok=True)

    # The launcher starts this process with no inherited std handles (see
    # Start-Detached in start-datastores.ps1) so that it cannot hold open the
    # pipe `npm run db:start` is waiting on. Writing the log from in here keeps
    # the diagnostics without needing the parent to redirect anything.
    if args.logfile:
        log = open(args.logfile, "a", encoding="utf-8", errors="replace")
        sys.stdout = log
        sys.stderr = log

    try:
        import chromadb
        from chromadb.cli import cli as chroma_cli
    except ImportError as exc:  # pragma: no cover - environment problem
        print(f"chromadb is not importable: {exc}", file=sys.stderr)
        print("Install it with:  python -m pip install chromadb", file=sys.stderr)
        return 1

    print(f"chroma {chromadb.__version__} -> http://{args.host}:{args.port}  data={args.path}", flush=True)

    # The Rust binding reads argv directly.
    sys.argv = ["chroma", "run", "--path", args.path, "--host", args.host, "--port", str(args.port)]
    chroma_cli.app()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
