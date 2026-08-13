from pathlib import Path
import sys


root = Path(__file__).resolve().parent.parent
required = (
    root / "SKILL.md",
    root / "agents" / "openai.yaml",
    root / "references" / "artifacts.md",
    root / "scripts" / "scene-artifact.mjs",
)

missing = [str(path.relative_to(root)) for path in required if not path.is_file()]
symlinks = [str(path.relative_to(root)) for path in root.rglob("*") if path.is_symlink()]

if missing or symlinks:
    if missing:
        print(f"missing required files: {', '.join(missing)}", file=sys.stderr)
    if symlinks:
        print(f"symlinks are not allowed: {', '.join(symlinks)}", file=sys.stderr)
    raise SystemExit(1)

print("SceneBoard skill validation PASS")
