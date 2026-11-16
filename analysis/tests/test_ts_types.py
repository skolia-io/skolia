import importlib.util
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT.parent / "shared" / "schema.gen.ts"
GENERATED_ZOD = ROOT.parent / "shared" / "schema.zod.gen.ts"


def _generator() -> Any:
    spec = importlib.util.spec_from_file_location(
        "gen_ts_types", ROOT / "scripts" / "gen_ts_types.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_typescript_types_are_up_to_date() -> None:
    expected: str = _generator().generate()
    assert GENERATED.read_text(encoding="utf-8") == expected, (
        "shared/schema.gen.ts is stale: run "
        "uv run python scripts/gen_ts_types.py > ../shared/schema.gen.ts"
    )


def test_zod_schemas_are_up_to_date() -> None:
    expected: str = _generator().generate_zod()
    assert GENERATED_ZOD.read_text(encoding="utf-8") == expected, (
        "shared/schema.zod.gen.ts is stale: run "
        "uv run python scripts/gen_ts_types.py zod > ../shared/schema.zod.gen.ts"
    )
