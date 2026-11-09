"""Create a clean, shareable ZIP of the FastAPI app."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist" / "chatBox-release.zip"
FILES = (
    "README.md",
    "requirements.txt",
    ".env.example",
    "server.py",
    "start.cmd",
    "start_vllm.ps1",
    "web/index.html",
    "web/style.css",
    "web/app.js",
)


def main() -> None:
    OUTPUT.parent.mkdir(exist_ok=True)
    with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED) as archive:
        for name in FILES:
            path = ROOT / name
            if not path.is_file():
                raise FileNotFoundError(path)
            archive.write(path, arcname=f"chatBox/{name}")

    with ZipFile(OUTPUT) as archive:
        bad_member = archive.testzip()
        if bad_member:
            raise RuntimeError(f"Corrupt archive member: {bad_member}")
    print(f"Created {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
